// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IPayment, IFdcVerification } from "./interfaces/IFdc.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface INightjarVenue {
    function depositFor(address trader, uint256 baseAmount, uint256 quoteAmount) external;
}

interface IFlareContractRegistry {
    function getContractAddressByName(string calldata _name) external view returns (address);
}

interface IFtsoV2 {
    function getFeedById(bytes21 _feedId) external payable returns (uint256 _value, int8 _decimals, uint64 _timestamp);
}

/// @title XrplGateway
/// @notice Funds a Nightjar balance with XRP paid on the XRP Ledger.
///
/// The reason FXRP has a large float and almost no depth is not that minting is
/// hard — it is that once you hold it there is nowhere to trade size without
/// announcing it. This closes the other end of that loop: an XRP holder pays
/// the desk on the XRPL, and the payment itself is what mints their balance
/// here. No bridge to trust, no operator taking custody of the XRP, and no
/// second signature on a chain they may never have used.
///
/// The only thing that moves value is a Merkle proof produced by Flare's Data
/// Connector over an XRPL transaction that actually settled. This contract is
/// deliberately incapable of crediting anyone without one.
///
/// **What the payer does.** Send XRP to `xrplAccountHash`'s account, with the
/// Flare address to credit as the payment's standard reference — for XRPL that
/// is a 32-byte memo, the address left-padded. The reference is the
/// instruction; there is no registration step and no off-chain matching.
///
/// **What is checked, in order.** Each of these is a way the gateway could
/// otherwise be drained, so none is optional:
///
/// | Check | What it stops |
/// |---|---|
/// | `verifyPayment` against FDC | A proof the Data Connector never issued |
/// | `attestationType` / `sourceId` | A proof about a different chain or type |
/// | `receivingAddressHash` | Crediting for a payment made to somebody else |
/// | `status == 0` | A transaction that failed on the XRPL |
/// | `claimed[transactionId]` | Presenting the same payment twice |
/// | `reference != 0` | A payment with no destination, which would burn funds |
///
/// **Pricing.** The credit is the XRP received, valued at Flare's own FTSO
/// XRP/USD feed read at claim time. The gateway never decides a price, exactly
/// as the auction never decides one: both defer to the same oracle.
///
/// **Where it lands.** Directly in the payer's venue balance, not their wallet.
/// They have just arrived from a chain where they hold no FLR, so a credit that
/// still required them to send a deposit transaction would not actually have
/// got them anywhere.
contract XrplGateway {
    /// @notice The Flare Contract Registry, at the same address on every Flare network.
    IFlareContractRegistry public constant FLARE_REGISTRY =
        IFlareContractRegistry(0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019);

    /// @notice FTSO feed id for XRP/USD — the same feed the auction is bounded by.
    bytes21 public constant XRP_USD_FEED_ID = bytes21(0x015852502f55534400000000000000000000000000);

    /// @dev "Payment", right-padded, as the Data Connector encodes attestation types.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant ATTESTATION_TYPE = bytes32("Payment");

    /// @notice XRP has 6 decimals on the ledger (drops), and so does the quote token.
    uint256 public constant DROPS_PER_XRP = 1e6;

    /// @notice The token credited to the payer. Same quote asset the auction uses.
    IERC20 public immutable QUOTE_TOKEN;

    /// @notice The venue the credit lands in.
    ///
    /// Crediting the payer's *wallet* would leave them one gas-funded
    /// transaction short of being able to trade, and they have just arrived
    /// from a chain where they hold no FLR. So the credit goes straight to
    /// their venue balance, ready to be sealed into a batch. Withdrawing it to
    /// their wallet is still available — from the venue, when they have gas.
    INightjarVenue public immutable VENUE;

    /// @dev `sourceId` this gateway accepts — "testXRP" on Coston2, "XRP" on mainnet.
    ///      Immutable so a mainnet deployment cannot be pointed at testnet proofs.
    bytes32 public immutable SOURCE_ID;

    /// @notice keccak256 of the desk's XRPL account, in the form the Data
    ///         Connector hashes it. Payments to any other account are not ours
    ///         to credit, however valid their proof.
    bytes32 public immutable XRPL_ACCOUNT_HASH;

    address public owner;

    /// @notice Each XRPL transaction can fund exactly once.
    mapping(bytes32 xrplTxId => bool used) public claimed;

    /// @notice Total XRP drops this gateway has honoured, for the record.
    uint256 public totalDropsCredited;

    event Funded(
        address indexed trader,
        bytes32 indexed xrplTxId,
        uint256 drops,
        uint256 quoteCredited,
        uint256 xrpUsdPrice
    );
    event OwnerChanged(address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error InvalidProof();
    error WrongAttestationType();
    error WrongSource();
    error WrongDestination();
    error PaymentFailedOnLedger();
    error AlreadyClaimed();
    error NoReference();
    error NothingReceived();
    error InsufficientFloat();
    error StalePrice();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IERC20 _quoteToken,
        INightjarVenue _venue,
        bytes32 _sourceId,
        bytes32 _xrplAccountHash
    ) {
        if (address(_quoteToken) == address(0) || address(_venue) == address(0)) revert ZeroAddress();
        if (_sourceId == bytes32(0) || _xrplAccountHash == bytes32(0)) revert ZeroAddress();
        QUOTE_TOKEN = _quoteToken;
        VENUE = _venue;
        SOURCE_ID = _sourceId;
        XRPL_ACCOUNT_HASH = _xrplAccountHash;
        owner = msg.sender;
        // One allowance up front rather than one per claim: the venue only ever
        // pulls what depositFor is told to, and that is bounded by the float.
        _quoteToken.approve(address(_venue), type(uint256).max);
    }

    /// @notice Credit the Flare address named in an XRPL payment's reference.
    /// @dev Permissionless on purpose. The proof carries its own beneficiary, so
    ///      anyone may submit it — including a relayer paying the gas for a payer
    ///      who has no FLR yet, which is the whole point of arriving from XRPL.
    function fund(IPayment.Proof calldata _proof) external returns (uint256 quoteCredited) {
        IFdcVerification verifier = IFdcVerification(
            FLARE_REGISTRY.getContractAddressByName("FdcVerification")
        );
        if (!verifier.verifyPayment(_proof)) revert InvalidProof();

        IPayment.Response calldata r = _proof.data;
        if (r.attestationType != ATTESTATION_TYPE) revert WrongAttestationType();
        if (r.sourceId != SOURCE_ID) revert WrongSource();

        IPayment.ResponseBody calldata b = r.responseBody;
        // A non-zero status is the XRPL telling us the transfer did not happen.
        if (b.status != 0) revert PaymentFailedOnLedger();
        if (b.receivingAddressHash != XRPL_ACCOUNT_HASH) revert WrongDestination();
        if (b.receivedAmount <= 0) revert NothingReceived();

        bytes32 txId = r.requestBody.transactionId;
        if (claimed[txId]) revert AlreadyClaimed();
        claimed[txId] = true;

        // The reference is the payer's instruction about where the value goes.
        // Without one there is no beneficiary and crediting address(0) would
        // destroy the float, so this reverts rather than guessing.
        address trader = address(uint160(uint256(b.standardPaymentReference)));
        if (trader == address(0)) revert NoReference();

        uint256 drops = uint256(b.receivedAmount);
        uint256 price = _xrpUsd();
        // drops (1e6) * price (1e18) / 1e18 -> quote units at 6 decimals.
        quoteCredited = (drops * price) / 1e18;
        if (quoteCredited == 0) revert NothingReceived();
        if (QUOTE_TOKEN.balanceOf(address(this)) < quoteCredited) revert InsufficientFloat();

        totalDropsCredited += drops;

        // Interactions last: state is already final above, so a token with a
        // callback cannot re-enter into a second credit for the same payment.
        VENUE.depositFor(trader, 0, quoteCredited);

        emit Funded(trader, txId, drops, quoteCredited, price);
    }

    /// @notice XRP/USD from Flare's own feed, normalised to 1e18.
    /// @dev Mirrors the auction's oracle read so both sides of the product agree
    ///      on what an XRP is worth at the moment they act.
    function _xrpUsd() private returns (uint256) {
        IFtsoV2 ftso = IFtsoV2(FLARE_REGISTRY.getContractAddressByName("FtsoV2"));
        (uint256 value, int8 decimals, uint64 timestamp) = ftso.getFeedById(XRP_USD_FEED_ID);
        if (value == 0 || timestamp == 0) revert StalePrice();
        if (decimals >= 0) {
            return value * (10 ** (18 - uint8(decimals)));
        }
        return value * (10 ** (18 + uint8(-decimals)));
    }

    /// @notice How much more XRP this gateway can still honour, in drops.
    /// @dev A payer should check this before sending, because the XRPL leg is
    ///      irreversible and the float here is not infinite.
    function remainingCapacityDrops() external returns (uint256) {
        uint256 price = _xrpUsd();
        if (price == 0) return 0;
        return (QUOTE_TOKEN.balanceOf(address(this)) * 1e18) / price;
    }

    // --- float management -------------------------------------------------

    /// @notice Withdraw unclaimed float. Deliberately does not touch `claimed`,
    ///         so draining the gateway can never re-open a settled payment.
    function withdraw(uint256 _amount, address _to) external onlyOwner {
        if (_to == address(0)) revert ZeroAddress();
        QUOTE_TOKEN.transfer(_to, _amount);
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert ZeroAddress();
        owner = _newOwner;
        emit OwnerChanged(_newOwner);
    }
}
