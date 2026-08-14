// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { NightjarAuction, IERC20 } from "../InstructionSender.sol";
import { ITeeExtensionRegistry } from "../interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../interfaces/ITeeMachineRegistry.sol";

contract MockERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockExtensionRegistry is ITeeExtensionRegistry {
    address public sender;

    function setSender(address _s) external {
        sender = _s;
    }

    function sendInstructions(address[] calldata, TeeInstructionParams calldata) external payable returns (bytes32) {
        return bytes32(uint256(1));
    }

    function nextPublicExtensionId() external pure returns (uint256) {
        return 0x10001;
    }

    function getTeeExtensionInstructionsSender(uint256) external view returns (address) {
        return sender;
    }
}

contract MockMachineRegistry is ITeeMachineRegistry {
    function getRandomTeeIds(uint256, uint256 _count) external pure returns (address[] memory) {
        address[] memory ids = new address[](_count);
        ids[0] = address(0x7EE);
        return ids;
    }
}

contract NightjarAuctionTest is Test {
    NightjarAuction internal venue;
    MockERC20 internal base;
    MockERC20 internal quote;
    MockExtensionRegistry internal extReg;
    MockMachineRegistry internal machReg;

    uint256 internal teeKey = 0xA11CE;
    address internal teeAddr;

    address internal alice = address(0xA);
    address internal bob = address(0xB);

    address internal constant MOCK_FTSO = address(0xF750);

    function setUp() public {
        base = new MockERC20();
        quote = new MockERC20();
        extReg = new MockExtensionRegistry();
        machReg = new MockMachineRegistry();

        venue = new NightjarAuction(extReg, machReg, IERC20(address(base)), IERC20(address(quote)));
        extReg.setSender(address(venue));
        venue.setExtensionId();

        teeAddr = vm.addr(teeKey);
        venue.addTee(teeAddr);

        base.mint(alice, 1_000_000);
        quote.mint(alice, 1_000_000);
        base.mint(bob, 1_000_000);
        quote.mint(bob, 1_000_000);
    }

    // --- helpers ------------------------------------------------------------

    function _deposit(address who, uint256 b, uint256 q) internal {
        vm.startPrank(who);
        venue.deposit(b, q);
        vm.stopPrank();
    }

    /// Mirrors the TEE node exactly: it hashes the payload, then signs that
    /// hash through accounts.TextHash, which applies the EIP-191 prefix.
    /// One signature, wrapped as the quorum array settle expects.
    function _quorum(bytes memory settlement) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](1);
        sigs[0] = _sign(settlement);
    }

    function _sign(bytes memory settlement) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(settlement))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teeKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _settlement(
        uint64 batchId,
        uint256 clearingPrice,
        uint256 matchedBase,
        NightjarAuction.Fill[] memory fills
    ) internal view returns (bytes memory) {
        return abi.encode(block.chainid, address(venue), batchId, clearingPrice, matchedBase, fills);
    }

    /// Points the venue's FTSO lookup at a mock feed returning `valueE6` with
    /// 6 decimals, so band checks can run without a live oracle.
    function _mockOracle(uint256 valueE6) internal {
        vm.mockCall(
            address(venue.FLARE_REGISTRY()),
            abi.encodeWithSignature("getContractAddressByName(string)", "FtsoV2"),
            abi.encode(MOCK_FTSO)
        );
        vm.mockCall(
            MOCK_FTSO,
            abi.encodeWithSignature("getFeedById(bytes21)"),
            abi.encode(valueE6, int8(6), uint64(block.timestamp))
        );
    }

    function _twoSidedFills() internal view returns (NightjarAuction.Fill[] memory fills) {
        fills = new NightjarAuction.Fill[](2);
        fills[0] = NightjarAuction.Fill({ trader: alice, baseDelta: int256(100), quoteDelta: -int256(250) });
        fills[1] = NightjarAuction.Fill({ trader: bob, baseDelta: -int256(100), quoteDelta: int256(250) });
    }

    // --- balances -----------------------------------------------------------

    /// The XRPL rail funds somebody who has no FLR, so the gateway pays and the
    /// balance has to land on the trader rather than the caller.
    function testDepositForCreditsTheNamedTraderNotTheCaller() public {
        base.mint(address(this), 500);
        quote.mint(address(this), 400);

        venue.depositFor(alice, 500, 400);

        assertEq(venue.baseBalance(alice), 500);
        assertEq(venue.quoteBalance(alice), 400);
        assertEq(venue.baseBalance(address(this)), 0, "the payer funds, the trader holds");
        assertEq(venue.quoteBalance(address(this)), 0);
    }

    function testDepositForRejectsZeroAddress() public {
        quote.mint(address(this), 100);
        vm.expectRevert(NightjarAuction.ZeroAddress.selector);
        venue.depositFor(address(0), 0, 100);
    }

    /// depositFor grants no authority over the recipient — it only ever adds.
    /// Withdrawal stays with whoever owns the balance.
    function testDepositForCannotMoveSomebodyElsesBalance() public {
        _deposit(alice, 500, 400);
        vm.prank(bob);
        vm.expectRevert(NightjarAuction.InsufficientBalance.selector);
        venue.withdraw(500, 0);
        assertEq(venue.baseBalance(alice), 500);
    }

    function testDepositCreditsBalances() public {
        _deposit(alice, 500, 400);
        assertEq(venue.baseBalance(alice), 500);
        assertEq(venue.quoteBalance(alice), 400);
    }

    function testWithdrawReturnsTokens() public {
        _deposit(alice, 500, 400);
        vm.prank(alice);
        venue.withdraw(200, 100);
        assertEq(venue.baseBalance(alice), 300);
        assertEq(base.balanceOf(alice), 1_000_000 - 500 + 200);
    }

    /// Submitting an order locks the trader's balance until the batch resolves,
    /// so funds backing a sealed order cannot be pulled out from under it.
    function testWithdrawBlockedWhileOrderResting() public {
        _deposit(alice, 500, 500);

        vm.prank(alice);
        venue.submitOrder(hex"deadbeef");

        vm.prank(alice);
        vm.expectRevert(NightjarAuction.BalanceLocked.selector);
        venue.withdraw(100, 0);
    }

    // --- settlement authenticity -------------------------------------------

    /// A settlement not signed by the registered TEE must be rejected outright.
    function testSettleRejectsForgedSignature() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());

        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(settlement))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBAD), digest);
        bytes[] memory forged = new bytes[](1);
        forged[0] = abi.encodePacked(r, s, v);

        // A well-formed signature from an unregistered key is not a bad
        // signature — it is an unknown signer, and must be named as such.
        vm.expectRevert(NightjarAuction.UnknownSigner.selector);
        venue.settle(settlement, forged);
    }

    /// A settlement signed for another venue must not execute here, even though
    /// the signature itself is valid.
    function testSettleRejectsWrongVenue() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        NightjarAuction.Fill[] memory fills = _twoSidedFills();
        bytes memory settlement =
            abi.encode(block.chainid, address(0xDEAD), uint64(1), uint256(2.5e18), uint256(100), fills);

        vm.expectRevert(bytes("wrong venue"));
        venue.settle(settlement, _quorum(settlement));
    }

    /// A batch may not be settled twice.
    function testSettleRejectsReplay() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        bytes[] memory sigs = _quorum(settlement);

        venue.settle(settlement, sigs);
        assertTrue(venue.batchSettled(1));

        vm.expectRevert(NightjarAuction.BatchAlreadySettled.selector);
        venue.settle(settlement, sigs);
    }

    // --- settlement soundness ----------------------------------------------

    /// Fills that do not net to zero would mint value from nothing.
    function testSettleRejectsUnconservedFills() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        NightjarAuction.Fill[] memory fills = new NightjarAuction.Fill[](2);
        fills[0] = NightjarAuction.Fill({ trader: alice, baseDelta: int256(100), quoteDelta: -int256(250) });
        // Bob sells less base than Alice receives.
        fills[1] = NightjarAuction.Fill({ trader: bob, baseDelta: -int256(50), quoteDelta: int256(250) });

        bytes memory settlement = _settlement(1, 2.5e18, 100, fills);

        vm.expectRevert(bytes("base not conserved"));
        venue.settle(settlement, _quorum(settlement));
    }

    /// A clearing price far from the oracle must be refused on-chain, even with
    /// a valid TEE signature. This is the check that bounds a compromised enclave.
    function testSettleRejectsOutOfBandClearingPrice() public {
        _deposit(alice, 0, 1_000_000);
        _deposit(bob, 1_000_000, 0);
        // Oracle says 2.50; the settlement claims 10.00 — a 300% deviation.
        _mockOracle(2_500_000);

        NightjarAuction.Fill[] memory fills = new NightjarAuction.Fill[](2);
        fills[0] = NightjarAuction.Fill({ trader: alice, baseDelta: int256(100), quoteDelta: -int256(1000) });
        fills[1] = NightjarAuction.Fill({ trader: bob, baseDelta: -int256(100), quoteDelta: int256(1000) });

        bytes memory settlement = _settlement(1, 10e18, 100, fills);

        vm.expectRevert(NightjarAuction.ClearingPriceOutOfBand.selector);
        venue.settle(settlement, _quorum(settlement));
    }

    /// The happy path: balances move by exactly the signed deltas.
    function testSettleAppliesDeltas() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        venue.settle(settlement, _quorum(settlement));

        assertEq(venue.baseBalance(alice), 100);
        assertEq(venue.quoteBalance(alice), 750);
        assertEq(venue.baseBalance(bob), 900);
        assertEq(venue.quoteBalance(bob), 250);
        assertEq(venue.currentBatchId(), 2);
    }

    /// Settling releases the lock, so a trader can withdraw again afterwards.
    function testWithdrawUnlocksAfterSettlement() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        vm.prank(alice);
        venue.submitOrder(hex"aa");

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        venue.settle(settlement, _quorum(settlement));

        vm.prank(alice);
        venue.withdraw(50, 0);
        assertEq(venue.baseBalance(alice), 50);
    }

    // --- protocol fee -------------------------------------------------------

    /// The venue charges both sides of a fill, and the fee lands with the
    /// recipient as an ordinary quote balance.
    function testFeeChargedToBothSides() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        // 5 bps of 250 truncates to 0, so use a notional where the fee bites.
        NightjarAuction.Fill[] memory fills = new NightjarAuction.Fill[](2);
        fills[0] = NightjarAuction.Fill({ trader: alice, baseDelta: int256(100), quoteDelta: -int256(200_000) });
        fills[1] = NightjarAuction.Fill({ trader: bob, baseDelta: -int256(100), quoteDelta: int256(200_000) });

        _deposit(alice, 0, 500_000);
        _deposit(bob, 0, 500_000);

        uint256 expectedFee = (200_000 * 5) / 10000; // 100 each side
        address recipient = venue.feeRecipient();
        uint256 recipientBefore = venue.quoteBalance(recipient);
        uint256 aliceBefore = venue.quoteBalance(alice);
        uint256 bobBefore = venue.quoteBalance(bob);

        bytes memory settlement = _settlement(1, 2.5e18, 100, fills);
        venue.settle(settlement, _quorum(settlement));

        // Buyer parts with the notional plus the fee.
        assertEq(aliceBefore - venue.quoteBalance(alice), 200_000 + expectedFee);
        // Seller receives the notional minus the fee.
        assertEq(venue.quoteBalance(bob) - bobBefore, 200_000 - expectedFee);
        // And the venue keeps both halves.
        assertEq(venue.quoteBalance(recipient) - recipientBefore, expectedFee * 2);
        assertEq(venue.feesCollected(), expectedFee * 2);
    }

    /// Fees must never be charged in a way that lets an unbalanced batch
    /// through: conservation is asserted on the raw deltas, before the fee.
    function testConservationCheckedBeforeFee() public {
        _deposit(alice, 0, 1_000_000);
        _deposit(bob, 1_000_000, 0);
        _mockOracle(2_500_000);

        NightjarAuction.Fill[] memory fills = new NightjarAuction.Fill[](2);
        fills[0] = NightjarAuction.Fill({ trader: alice, baseDelta: int256(100), quoteDelta: -int256(200_000) });
        fills[1] = NightjarAuction.Fill({ trader: bob, baseDelta: -int256(100), quoteDelta: int256(199_000) });

        bytes memory settlement = _settlement(1, 2.5e18, 100, fills);
        vm.expectRevert(bytes("quote not conserved"));
        venue.settle(settlement, _quorum(settlement));
    }

    /// The fee ceiling is in the bytecode, so depositing does not require
    /// trusting the owner not to raise it later.
    function testFeeCannotExceedCeiling() public {
        uint16 ceiling = venue.MAX_FEE_BPS();
        vm.expectRevert(NightjarAuction.FeeTooHigh.selector);
        venue.setFee(ceiling + 1, address(0xFEE));

        venue.setFee(ceiling, address(0xFEE));
        assertEq(venue.feeBps(), ceiling);
        assertEq(venue.feeRecipient(), address(0xFEE));
    }

    function testOnlyOwnerCanSetFee() public {
        vm.prank(alice);
        vm.expectRevert(NightjarAuction.NotOwner.selector);
        venue.setFee(1, alice);
    }

    /// A zero fee is a valid configuration and must not break settlement.
    function testZeroFeeSettles() public {
        venue.setFee(0, address(0xFEE));
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        venue.settle(settlement, _quorum(settlement));

        assertEq(venue.feesCollected(), 0);
        assertEq(venue.baseBalance(alice), 100);
        assertEq(venue.quoteBalance(alice), 750);
    }

    // --- multi-enclave settlement ------------------------------------------

    uint256 internal teeKey2 = 0xB0B;
    uint256 internal teeKey3 = 0xC0C;

    function _signWith(uint256 key, bytes memory settlement) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(settlement))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Signatures must be ordered by signer address; sort so tests submit a
    /// valid quorum rather than accidentally testing the ordering rule.
    function _sorted(uint256 k1, uint256 k2, bytes memory settlement)
        internal
        pure
        returns (bytes[] memory sigs)
    {
        sigs = new bytes[](2);
        if (vm.addr(k1) < vm.addr(k2)) {
            sigs[0] = _signWith(k1, settlement);
            sigs[1] = _signWith(k2, settlement);
        } else {
            sigs[0] = _signWith(k2, settlement);
            sigs[1] = _signWith(k1, settlement);
        }
    }

    function _twoEnclaves() internal {
        venue.addTee(vm.addr(teeKey2));
        venue.setSignatureThreshold(2);
    }

    /// With two enclaves required, one signature is not enough — even a
    /// perfectly valid one from a registered enclave.
    function testOneSignatureFailsWhenTwoRequired() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);
        _twoEnclaves();

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());

        vm.expectRevert(NightjarAuction.NotEnoughSignatures.selector);
        venue.settle(settlement, _quorum(settlement));
    }

    /// Two distinct registered enclaves agreeing settles the batch.
    function testTwoEnclavesSettle() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);
        _twoEnclaves();

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        venue.settle(settlement, _sorted(teeKey, teeKey2, settlement));

        assertTrue(venue.batchSettled(1));
        assertEq(venue.baseBalance(alice), 100);
    }

    /// The same enclave signing twice must not satisfy a threshold of two.
    /// This is the attack the ordering rule exists to stop.
    function testSameEnclaveCannotSignTwice() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);
        _twoEnclaves();

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        bytes[] memory doubled = new bytes[](2);
        doubled[0] = _sign(settlement);
        doubled[1] = _sign(settlement);

        vm.expectRevert(NightjarAuction.DuplicateSigner.selector);
        venue.settle(settlement, doubled);
    }

    /// A registered enclave plus an unregistered one is not a quorum.
    function testUnregisteredEnclaveDoesNotCount() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);
        _twoEnclaves();

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        // teeKey3 was never registered.
        vm.expectRevert(NightjarAuction.UnknownSigner.selector);
        venue.settle(settlement, _sorted(teeKey, teeKey3, settlement));
    }

    /// Enclaves that disagree cannot combine: a signature over different
    /// settlement bytes recovers to a different address, so it is not a
    /// registered signer for *these* bytes.
    function testDisagreeingEnclavesCannotSettle() public {
        _deposit(alice, 0, 1_000_000);
        _deposit(bob, 1_000_000, 0);
        _mockOracle(2_500_000);
        _twoEnclaves();

        bytes memory honest = _settlement(1, 2.5e18, 100, _twoSidedFills());
        bytes memory divergent = _settlement(1, 2.4e18, 100, _twoSidedFills());

        bytes[] memory mixed = new bytes[](2);
        mixed[0] = _signWith(teeKey, honest);
        mixed[1] = _signWith(teeKey2, divergent);

        // Whichever way the array sorts, one signature does not cover `honest`.
        vm.expectRevert();
        venue.settle(honest, mixed);
    }

    /// The threshold cannot exceed the number of registered enclaves, or the
    /// venue would deadlock with funds inside it.
    function testThresholdCannotExceedRegisteredEnclaves() public {
        vm.expectRevert(NightjarAuction.BadThreshold.selector);
        venue.setSignatureThreshold(2); // only one enclave registered

        vm.expectRevert(NightjarAuction.BadThreshold.selector);
        venue.setSignatureThreshold(0);
    }

    function testRegisteringSameEnclaveTwiceIsIdempotent() public {
        assertEq(venue.teeSignerCount(), 1);
        venue.addTee(teeAddr);
        assertEq(venue.teeSignerCount(), 1, "no duplicate entry");
    }

    // --- batch history ------------------------------------------------------

    /// A settled batch records what it cleared at, so the venue's history is
    /// readable from storage without an indexer or a log scan.
    function testSettlementRecordsBatchHistory() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        vm.prank(alice);
        venue.submitOrder(hex"aa");
        vm.prank(bob);
        venue.submitOrder(hex"bb");

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        venue.settle(settlement, _quorum(settlement));

        (
            uint256 clearingPrice,
            uint256 matchedBase,
            uint256 feeCharged,
            uint64 settledAt,
            uint32 fillCount,
            uint32 orderCount
        ) = venue.batches(1);

        assertEq(clearingPrice, 2.5e18);
        assertEq(matchedBase, 100);
        assertEq(fillCount, 2);
        assertEq(orderCount, 2, "records how many orders were in the batch");
        assertEq(feeCharged, 0, "5 bps of 250 truncates to zero");
        assertGt(settledAt, 0);
    }

    /// History must say nothing about individual orders — only aggregates.
    function testBatchHistoryHoldsNoOrderTerms() public {
        _deposit(alice, 0, 1000);
        _deposit(bob, 1000, 0);
        _mockOracle(2_500_000);

        bytes memory settlement = _settlement(1, 2.5e18, 100, _twoSidedFills());
        venue.settle(settlement, _quorum(settlement));

        (uint256 clearingPrice, uint256 matchedBase,,, uint32 fillCount,) = venue.batches(1);
        // Everything recorded is a batch-level aggregate; there is no per-order
        // slot to read at all.
        assertEq(clearingPrice, 2.5e18);
        assertEq(matchedBase, 100);
        assertEq(fillCount, 2);
    }

    /// An abandoned batch is recorded as cleared-at-nothing rather than left
    /// blank, so the history has no silent gaps.
    function testCancelledBatchIsRecorded() public {
        _deposit(alice, 500, 500);
        vm.prank(alice);
        venue.submitOrder(hex"aa");

        uint64 batchId = venue.currentBatchId();
        venue.cancelBatch(); // owner is this test contract

        (uint256 clearingPrice, uint256 matchedBase,, uint64 settledAt,, uint32 orderCount) =
            venue.batches(batchId);

        assertTrue(venue.batchSettled(batchId));
        assertEq(clearingPrice, 0, "abandoned batches clear at nothing");
        assertEq(matchedBase, 0);
        assertEq(orderCount, 1, "but still records how many orders it held");
        assertGt(settledAt, 0, "and when it was resolved");
        assertEq(venue.currentBatchId(), batchId + 1);
    }

    /// Abandoning a batch must release the locks so traders can withdraw.
    function testCancelReleasesLockedBalances() public {
        _deposit(alice, 500, 500);
        vm.prank(alice);
        venue.submitOrder(hex"aa");

        vm.prank(alice);
        vm.expectRevert(NightjarAuction.BalanceLocked.selector);
        venue.withdraw(100, 0);

        venue.cancelBatch();

        vm.prank(alice);
        venue.withdraw(100, 0);
        assertEq(venue.baseBalance(alice), 400);
    }

    // --- access control and privacy surface --------------------------------

    function testSubmitOrderRequiresTee() public {
        NightjarAuction fresh = new NightjarAuction(extReg, machReg, IERC20(address(base)), IERC20(address(quote)));
        vm.expectRevert(NightjarAuction.TeeNotSet.selector);
        fresh.submitOrder(hex"01");
    }

    function testOnlyOwnerCanSetTee() public {
        vm.prank(alice);
        vm.expectRevert(NightjarAuction.NotOwner.selector);
        venue.addTee(address(0x1234));
    }

    /// The chain learns that an address traded and how many orders a batch held,
    /// but the contract never stores or emits order terms.
    function testOrderCountIsTheOnlyBookStatistic() public {
        _deposit(alice, 500, 500);
        _deposit(bob, 500, 500);

        vm.prank(alice);
        venue.submitOrder(hex"aa");
        vm.prank(bob);
        venue.submitOrder(hex"bb");

        assertEq(venue.batchOrderCount(1), 2);
    }

    function testRunBatchRevertsOnEmptyBatch() public {
        vm.expectRevert(NightjarAuction.NothingToDo.selector);
        venue.runBatch();
    }
}
