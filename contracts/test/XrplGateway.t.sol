// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { XrplGateway, IERC20, INightjarVenue } from "../XrplGateway.sol";
import { IPayment } from "../interfaces/IFdc.sol";

contract MockERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Stands in for the venue: records what landed in whose balance, and pulls the
/// tokens the way the real depositFor does, so the gateway's allowance and the
/// transfer both have to be right.
contract MockVenue is INightjarVenue {
    MockERC20 public immutable QUOTE;
    mapping(address => uint256) public quoteBalance;

    constructor(MockERC20 quote) {
        QUOTE = quote;
    }

    function depositFor(address trader, uint256, uint256 quoteAmount) external {
        require(QUOTE.transferFrom(msg.sender, address(this), quoteAmount), "pull failed");
        quoteBalance[trader] += quoteAmount;
    }
}

/// Every test here is about one question: can value leave this contract without
/// a Data Connector proof of an XRPL payment that actually settled, to the
/// desk's account, that has not already been honoured? The happy path is one
/// test; the rest are the ways the answer could be yes.
contract XrplGatewayTest is Test {
    XrplGateway internal gateway;
    MockERC20 internal quote;
    MockVenue internal venue;

    address internal constant MOCK_FTSO = address(0xF7501);
    address internal constant MOCK_VERIFIER = address(0xFDC1);
    address internal alice = address(0xA11CE);
    address internal relayer = address(0xBEEF);

    bytes32 internal constant DESK_XRPL = keccak256("rLVHnCwBLXxW4FhuQdSvihxT4s8v5Y6yVf");
    bytes32 internal constant SOMEONE_ELSE_XRPL = keccak256("rSomeoneElsesAccount");
    bytes32 internal constant SOURCE_TEST_XRP = bytes32("testXRP");
    bytes32 internal constant TX_ID = bytes32(uint256(0x7c68e0));

    /// XRP/USD at 2.00, in the 6-decimal form the feed reports.
    uint256 internal constant XRP_USD_E6 = 2_000_000;

    function setUp() public {
        quote = new MockERC20();
        venue = new MockVenue(quote);
        gateway = new XrplGateway(
            IERC20(address(quote)), INightjarVenue(address(venue)), SOURCE_TEST_XRP, DESK_XRPL
        );
        // A float to pay claims out of. 10,000 quote units at 6 decimals.
        quote.mint(address(gateway), 10_000 * 1e6);
        _mockOracle(XRP_USD_E6);
        _mockVerifier(true);
    }

    // --- harness ------------------------------------------------------------

    function _mockOracle(uint256 valueE6) internal {
        vm.mockCall(
            address(gateway.FLARE_REGISTRY()),
            abi.encodeWithSignature("getContractAddressByName(string)", "FtsoV2"),
            abi.encode(MOCK_FTSO)
        );
        vm.mockCall(
            MOCK_FTSO,
            abi.encodeWithSignature("getFeedById(bytes21)"),
            abi.encode(valueE6, int8(6), uint64(block.timestamp))
        );
    }

    /// The Data Connector's verdict is the only thing standing between a
    /// caller and the float, so every test controls it explicitly.
    function _mockVerifier(bool verdict) internal {
        vm.mockCall(
            address(gateway.FLARE_REGISTRY()),
            abi.encodeWithSignature("getContractAddressByName(string)", "FdcVerification"),
            abi.encode(MOCK_VERIFIER)
        );
        vm.mockCall(
            MOCK_VERIFIER,
            abi.encodeWithSelector(bytes4(keccak256("verifyPayment((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,uint256,uint256),(uint64,uint64,bytes32,bytes32,bytes32,bytes32,int256,int256,int256,int256,bytes32,bool,uint8))))"))),
            abi.encode(verdict)
        );
    }

    /// A well-formed proof of `drops` sent to the desk, referencing `beneficiary`.
    function _proof(
        bytes32 txId,
        bytes32 destination,
        address beneficiary,
        int256 drops,
        uint8 status
    ) internal pure returns (IPayment.Proof memory p) {
        p.merkleProof = new bytes32[](0);
        p.data.attestationType = bytes32("Payment");
        p.data.sourceId = SOURCE_TEST_XRP;
        p.data.votingRound = 1425086;
        p.data.requestBody.transactionId = txId;
        p.data.responseBody.receivingAddressHash = destination;
        p.data.responseBody.receivedAmount = drops;
        p.data.responseBody.standardPaymentReference = bytes32(uint256(uint160(beneficiary)));
        p.data.responseBody.status = status;
        p.data.responseBody.oneToOne = true;
    }

    function _goodProof() internal view returns (IPayment.Proof memory) {
        // 12 XRP, the amount actually sent on the XRPL in the live demo.
        return _proof(TX_ID, DESK_XRPL, alice, 12 * 1e6, 0);
    }

    // --- the happy path -----------------------------------------------------

    function testFundCreditsTheAddressInTheReference() public {
        gateway.fund(_goodProof());
        // 12 XRP at 2.00 = 24 quote units, at 6 decimals.
        assertEq(venue.quoteBalance(alice), 24 * 1e6, "credit must land in the venue, ready to trade");
        assertEq(quote.balanceOf(alice), 0, "and not in the wallet, where it would need gas to move");
        assertEq(gateway.totalDropsCredited(), 12 * 1e6);
        assertTrue(gateway.claimed(TX_ID));
    }

    /// The payer may hold no FLR at all — that is the point of arriving from
    /// the XRPL — so anyone must be able to carry the proof for them.
    function testAnyoneCanSubmitOnBehalfOfThePayer() public {
        vm.prank(relayer);
        gateway.fund(_goodProof());
        assertEq(venue.quoteBalance(alice), 24 * 1e6);
        assertEq(venue.quoteBalance(relayer), 0, "the relayer pays gas and receives nothing");
    }

    function testCreditFollowsTheOraclePrice() public {
        _mockOracle(3_000_000); // XRP/USD at 3.00
        gateway.fund(_goodProof());
        assertEq(venue.quoteBalance(alice), 36 * 1e6);
    }

    // --- the ways it could be drained ---------------------------------------

    function testSamePaymentCannotBeClaimedTwice() public {
        gateway.fund(_goodProof());
        vm.expectRevert(XrplGateway.AlreadyClaimed.selector);
        gateway.fund(_goodProof());
        assertEq(venue.quoteBalance(alice), 24 * 1e6);
    }

    function testProofTheDataConnectorRejectsIsRefused() public {
        _mockVerifier(false);
        vm.expectRevert(XrplGateway.InvalidProof.selector);
        gateway.fund(_goodProof());
    }

    function testPaymentToAnotherAccountIsNotOursToCredit() public {
        vm.expectRevert(XrplGateway.WrongDestination.selector);
        gateway.fund(_proof(TX_ID, SOMEONE_ELSE_XRPL, alice, 12 * 1e6, 0));
    }

    function testLedgerFailureIsRefused() public {
        vm.expectRevert(XrplGateway.PaymentFailedOnLedger.selector);
        gateway.fund(_proof(TX_ID, DESK_XRPL, alice, 12 * 1e6, 1));
    }

    function testProofFromAnotherChainIsRefused() public {
        IPayment.Proof memory p = _goodProof();
        p.data.sourceId = bytes32("testBTC");
        vm.expectRevert(XrplGateway.WrongSource.selector);
        gateway.fund(p);
    }

    function testProofOfADifferentAttestationTypeIsRefused() public {
        IPayment.Proof memory p = _goodProof();
        p.data.attestationType = bytes32("AddressValidity");
        vm.expectRevert(XrplGateway.WrongAttestationType.selector);
        gateway.fund(p);
    }

    /// A payment with no reference names nobody. Crediting address(0) would
    /// quietly destroy the float, so it has to revert.
    function testPaymentWithNoReferenceIsRefused() public {
        vm.expectRevert(XrplGateway.NoReference.selector);
        gateway.fund(_proof(TX_ID, DESK_XRPL, address(0), 12 * 1e6, 0));
    }

    function testZeroValuePaymentIsRefused() public {
        vm.expectRevert(XrplGateway.NothingReceived.selector);
        gateway.fund(_proof(TX_ID, DESK_XRPL, alice, 0, 0));
    }

    function testNegativeReceivedAmountIsRefused() public {
        vm.expectRevert(XrplGateway.NothingReceived.selector);
        gateway.fund(_proof(TX_ID, DESK_XRPL, alice, -1, 0));
    }

    /// The XRPL leg is irreversible, so running dry must be a clean revert the
    /// payer can see coming — never a partial credit.
    function testClaimBeyondTheFloatRevertsRatherThanPayingPartially() public {
        // 10,000 XRP at 2.00 = 20,000 quote, against a 10,000 float.
        vm.expectRevert(XrplGateway.InsufficientFloat.selector);
        gateway.fund(_proof(TX_ID, DESK_XRPL, alice, 10_000 * 1e6, 0));
        assertEq(venue.quoteBalance(alice), 0);
        assertFalse(gateway.claimed(TX_ID), "a failed claim must stay claimable");
    }

    function testStaleOracleIsRefused() public {
        _mockOracle(0);
        vm.expectRevert(XrplGateway.StalePrice.selector);
        gateway.fund(_goodProof());
    }

    // --- float management ---------------------------------------------------

    function testOnlyOwnerCanWithdrawFloat() public {
        vm.prank(alice);
        vm.expectRevert(XrplGateway.NotOwner.selector);
        gateway.withdraw(1, alice);
    }

    /// Draining the float must not reopen payments already honoured, or the
    /// owner could recycle the gateway and double-credit.
    function testWithdrawingFloatDoesNotReopenSettledPayments() public {
        gateway.fund(_goodProof());
        gateway.withdraw(quote.balanceOf(address(gateway)), address(this));
        assertTrue(gateway.claimed(TX_ID));
        quote.mint(address(gateway), 10_000 * 1e6);
        vm.expectRevert(XrplGateway.AlreadyClaimed.selector);
        gateway.fund(_goodProof());
    }

    function testCapacityTracksTheFloat() public {
        // 10,000 quote at 2.00 buys 5,000 XRP of capacity.
        assertEq(gateway.remainingCapacityDrops(), 5_000 * 1e6);
        gateway.fund(_goodProof());
        assertEq(gateway.remainingCapacityDrops(), 4_988 * 1e6);
    }

    function testDistinctPaymentsBothSettle() public {
        gateway.fund(_goodProof());
        gateway.fund(_proof(bytes32(uint256(0xDEAD)), DESK_XRPL, alice, 6 * 1e6, 0));
        assertEq(venue.quoteBalance(alice), 36 * 1e6);
        assertEq(gateway.totalDropsCredited(), 18 * 1e6);
    }
}
