// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IFlareContractRegistry {
    function getContractAddressByName(string calldata _name) external view returns (address);
}

interface IFtsoV2 {
    function getFeedById(bytes21 _feedId) external payable returns (uint256 _value, int8 _decimals, uint64 _timestamp);
}

/// @title NightjarAuction
/// @notice A sealed-bid, uniform-price batch auction for FXRP.
///
/// Orders are ECIES-encrypted to the TEE's public key before they are sent, so
/// the book exists only inside the enclave. The chain sees that an address
/// submitted *an* order — never its side, price, or size. Orders that do not
/// trade are discarded inside the enclave and never revealed at all.
///
/// The enclave is not blindly trusted. Every settlement is bounded twice by
/// Flare's own oracle: once inside the TEE, and again here, independently, when
/// the settlement is presented for execution. A signature from the registered
/// TEE is necessary to settle, but it is not sufficient.
contract NightjarAuction {
    // --- FCC operation identifiers. These strings must match the Go config exactly. ---

    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_AUCTION = bytes32("AUCTION");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_SUBMIT_ORDER = bytes32("SUBMIT_ORDER");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_RUN_BATCH = bytes32("RUN_BATCH");

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;
    uint256 private _extensionId;

    /// @notice The Flare Contract Registry, at the same address on every Flare network.
    IFlareContractRegistry public constant FLARE_REGISTRY =
        IFlareContractRegistry(0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019);

    /// @notice FTSO feed id for XRP/USD.
    bytes21 public constant XRP_USD_FEED_ID = bytes21(0x015852502f55534400000000000000000000000000);

    /// @notice Prices are quote units per 1.0 base unit, scaled by 1e18.
    uint256 public constant PRICE_SCALE = 1e18;

    IERC20 public immutable BASE_TOKEN;
    IERC20 public immutable QUOTE_TOKEN;

    address public owner;

    /// @notice Addresses accepted as settlement signers — the TEE machines
    /// registered to serve this extension.
    mapping(address signer => bool accepted) public isTee;

    /// @notice The registered signers, so the set is enumerable off-chain.
    address[] public teeSigners;

    /// @notice How many distinct registered enclaves must agree on a settlement
    /// before it executes.
    ///
    /// A single enclave is a single point of trust: whoever compromises it
    /// chooses the clearing price within the oracle band. Requiring agreement
    /// removes that. It is only possible because matching is deterministic —
    /// the engine is a pure function of (orders, reference price, tolerance),
    /// so honest enclaves given the same batch produce byte-identical
    /// settlements and therefore signatures over the same digest.
    uint8 public signatureThreshold = 1;

    /// @notice Maximum allowed deviation of the clearing price from the FTSO
    /// reference, in basis points. Enforced here as well as in the enclave.
    uint32 public maxDeviationBps = 500;

    /// @notice Protocol fee on matched notional, in basis points, charged to
    /// both sides of a fill.
    ///
    /// The venue earns on volume it actually matches, and only then — an
    /// unmatched order costs nothing. At 5 bps a trader pays a small fraction
    /// of what a transparent book costs them in revealed intent, which is the
    /// entire commercial case for the venue.
    uint16 public feeBps = 5;

    /// @notice Hard ceiling on the fee, fixed at deployment and unraisable.
    /// Governance can lower the fee but can never take more than this, so
    /// depositing does not require trusting the owner not to raise it later.
    uint16 public constant MAX_FEE_BPS = 30;

    /// @notice Where protocol fees accrue, as a quote-token balance like any
    /// other. Fees are withdrawn through the same path as user funds.
    address public feeRecipient;

    /// @notice Total quote collected in fees, for accounting.
    uint256 public feesCollected;

    uint64 public currentBatchId = 1;
    uint64 public nextOrderId = 1;

    mapping(address trader => uint256 amount) public baseBalance;
    mapping(address trader => uint256 amount) public quoteBalance;

    /// @notice The batch a trader has unsettled orders in. Their balance is
    /// locked until that batch settles.
    mapping(address trader => uint64 batchId) public lockedInBatch;
    mapping(uint64 batchId => bool isSettled) public batchSettled;

    /// @notice Number of orders submitted into a batch. Public by design: it is
    /// the only book statistic the venue advertises.
    mapping(uint64 batchId => uint32 count) public batchOrderCount;

    /// @notice What a settled batch cleared at.
    ///
    /// Kept in storage rather than left to events so the venue's own history is
    /// readable from any RPC without an indexer — and because a public RPC that
    /// caps `eth_getLogs` at 30 blocks makes event history impractical for
    /// clients. Nothing here describes an individual order.
    struct BatchResult {
        uint256 clearingPrice;
        uint256 matchedBase;
        uint256 feeCharged;
        uint64 settledAt;
        uint32 fillCount;
        uint32 orderCount;
    }

    mapping(uint64 batchId => BatchResult result) public batches;

    struct Fill {
        address trader;
        int256 baseDelta;
        int256 quoteDelta;
    }

    struct SubmitOrderMessage {
        uint64 orderId;
        uint64 batchId;
        address trader;
        bytes ciphertext;
    }

    struct RunBatchMessage {
        uint64 batchId;
        uint256 refPrice;
        uint32 maxDeviationBps;
        uint256 chainId;
        address venue;
    }

    event Deposited(address indexed trader, uint256 baseAmount, uint256 quoteAmount);
    event Withdrawn(address indexed trader, uint256 baseAmount, uint256 quoteAmount);
    event OrderSubmitted(address indexed trader, uint64 indexed batchId, uint64 orderId);
    event BatchRequested(uint64 indexed batchId, uint256 refPrice);
    event BatchSettled(uint64 indexed batchId, uint256 clearingPrice, uint256 matchedBase, uint256 fillCount);
    event FeeCharged(uint64 indexed batchId, uint256 amount);
    event FeeConfigured(uint16 feeBps, address feeRecipient);
    event TeeAddressSet(address indexed teeAddress);
    event ThresholdSet(uint8 threshold);

    error NotOwner();
    error ZeroAddress();
    error TeeNotSet();
    error BatchAlreadySettled();
    error BadSignature();
    error InsufficientBalance();
    error BalanceLocked();
    error ClearingPriceOutOfBand();
    error StaleOracle();
    error NothingToDo();
    error FeeTooHigh();
    error BadThreshold();
    error NotEnoughSignatures();
    error DuplicateSigner();
    error UnknownSigner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry,
        IERC20 _baseToken,
        IERC20 _quoteToken
    ) {
        if (address(_teeExtensionRegistry) == address(0)) revert ZeroAddress();
        if (address(_teeMachineRegistry) == address(0)) revert ZeroAddress();
        if (address(_baseToken) == address(0)) revert ZeroAddress();
        if (address(_quoteToken) == address(0)) revert ZeroAddress();
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");

        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
        BASE_TOKEN = _baseToken;
        QUOTE_TOKEN = _quoteToken;
        owner = msg.sender;
        feeRecipient = msg.sender;
    }

    /// @notice Finds and caches this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Registers an enclave as an accepted settlement signer.
    function addTee(address _teeAddress) external onlyOwner {
        if (_teeAddress == address(0)) revert ZeroAddress();
        if (!isTee[_teeAddress]) {
            isTee[_teeAddress] = true;
            teeSigners.push(_teeAddress);
        }
        emit TeeAddressSet(_teeAddress);
    }

    /// @notice Sets how many distinct enclaves must agree. Cannot exceed the
    /// number registered, or settlement would be impossible.
    function setSignatureThreshold(uint8 _threshold) external onlyOwner {
        if (_threshold == 0 || _threshold > teeSigners.length) revert BadThreshold();
        signatureThreshold = _threshold;
        emit ThresholdSet(_threshold);
    }

    function teeSignerCount() external view returns (uint256) {
        return teeSigners.length;
    }

    /// @notice The first registered signer. Kept so existing tooling that
    /// expects a single TEE address keeps working.
    function teeAddress() external view returns (address) {
        return teeSigners.length == 0 ? address(0) : teeSigners[0];
    }

    function setMaxDeviationBps(uint32 _bps) external onlyOwner {
        maxDeviationBps = _bps;
    }

    /// @notice Sets the protocol fee and where it accrues. The fee can never
    /// exceed MAX_FEE_BPS, which is fixed in the bytecode.
    function setFee(uint16 _feeBps, address _feeRecipient) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emit FeeConfigured(_feeBps, _feeRecipient);
    }

    // --- Balances -----------------------------------------------------------
    //
    // Deposits are decoupled from orders on purpose. If a trader funded the
    // exact size of each order, the transfer amount would leak the order size,
    // which is precisely what this venue exists to hide.

    function deposit(uint256 _baseAmount, uint256 _quoteAmount) external {
        _deposit(msg.sender, msg.sender, _baseAmount, _quoteAmount);
    }

    /// @notice Fund somebody else's balance, pulling the tokens from the caller.
    ///
    /// This exists for arrivals from the XRP Ledger. Someone who has just paid
    /// XRP has no FLR, so if the gateway credited their wallet they would be
    /// stranded one gas-funded transaction short of being able to deposit —
    /// which defeats the point of the rail. The gateway calls this instead and
    /// the balance is simply there.
    ///
    /// It grants no authority over `_trader`: the caller spends its own tokens,
    /// and the recipient can only ever withdraw or trade what arrived. There is
    /// deliberately no matching `withdrawFor`.
    function depositFor(address _trader, uint256 _baseAmount, uint256 _quoteAmount) external {
        if (_trader == address(0)) revert ZeroAddress();
        _deposit(msg.sender, _trader, _baseAmount, _quoteAmount);
    }

    function _deposit(address _from, address _trader, uint256 _baseAmount, uint256 _quoteAmount) private {
        if (_baseAmount == 0 && _quoteAmount == 0) revert NothingToDo();
        if (_baseAmount > 0) {
            require(BASE_TOKEN.transferFrom(_from, address(this), _baseAmount), "base transfer failed");
            baseBalance[_trader] += _baseAmount;
        }
        if (_quoteAmount > 0) {
            require(QUOTE_TOKEN.transferFrom(_from, address(this), _quoteAmount), "quote transfer failed");
            quoteBalance[_trader] += _quoteAmount;
        }
        emit Deposited(_trader, _baseAmount, _quoteAmount);
    }

    function withdraw(uint256 _baseAmount, uint256 _quoteAmount) external {
        uint64 locked = lockedInBatch[msg.sender];
        if (locked != 0 && !batchSettled[locked]) revert BalanceLocked();
        if (_baseAmount > baseBalance[msg.sender]) revert InsufficientBalance();
        if (_quoteAmount > quoteBalance[msg.sender]) revert InsufficientBalance();

        if (_baseAmount > 0) {
            baseBalance[msg.sender] -= _baseAmount;
            require(BASE_TOKEN.transfer(msg.sender, _baseAmount), "base transfer failed");
        }
        if (_quoteAmount > 0) {
            quoteBalance[msg.sender] -= _quoteAmount;
            require(QUOTE_TOKEN.transfer(msg.sender, _quoteAmount), "quote transfer failed");
        }
        emit Withdrawn(msg.sender, _baseAmount, _quoteAmount);
    }

    // --- Trading ------------------------------------------------------------

    /// @notice Submits a sealed order into the current batch.
    /// @param _ciphertext ECIES ciphertext, encrypted to the TEE public key,
    /// of {trader, side, limitPrice, size, nonce}. The contract cannot read it.
    function submitOrder(bytes calldata _ciphertext) external payable {
        if (teeSigners.length == 0) revert TeeNotSet();
        require(_ciphertext.length > 0, "empty ciphertext");

        uint64 orderId = nextOrderId++;
        uint64 batchId = currentBatchId;

        lockedInBatch[msg.sender] = batchId;
        batchOrderCount[batchId] += 1;

        // The trader is bound here, on-chain, so a ciphertext cannot be replayed
        // by a third party to submit an order attributed to someone else. The
        // enclave rejects any order whose plaintext trader disagrees with this.
        bytes memory message = abi.encode(
            SubmitOrderMessage({ orderId: orderId, batchId: batchId, trader: msg.sender, ciphertext: _ciphertext })
        );

        _send(OP_COMMAND_SUBMIT_ORDER, message);
        emit OrderSubmitted(msg.sender, batchId, orderId);
    }

    /// @notice Asks the enclave to clear the current batch. Permissionless:
    /// anyone may trigger a batch, and no one can influence its outcome.
    function runBatch() external payable {
        if (teeSigners.length == 0) revert TeeNotSet();
        uint64 batchId = currentBatchId;
        if (batchOrderCount[batchId] == 0) revert NothingToDo();

        uint256 refPrice = _referencePrice();

        bytes memory message = abi.encode(
            RunBatchMessage({
                batchId: batchId,
                refPrice: refPrice,
                maxDeviationBps: maxDeviationBps,
                chainId: block.chainid,
                venue: address(this)
            })
        );

        _send(OP_COMMAND_RUN_BATCH, message);
        emit BatchRequested(batchId, refPrice);
    }

    /// @notice Executes a settlement produced by the enclave.
    /// @param _settlement abi.encode(chainId, contract, batchId, clearingPrice, matchedBase, Fill[])
    ///
    /// A valid TEE signature is necessary but not sufficient: the clearing price
    /// is re-checked here against a freshly read FTSO feed, and the fills must
    /// conserve both assets. A compromised enclave still cannot settle the venue
    /// at an arbitrary price, nor mint value out of nothing.
    /// @param _signatures One 65-byte signature per attesting enclave. They must
    /// come from distinct registered signers, and there must be at least
    /// `signatureThreshold` of them.
    function settle(bytes calldata _settlement, bytes[] calldata _signatures) external {
        if (teeSigners.length == 0) revert TeeNotSet();

        _verifyQuorum(_settlement, _signatures);

        (
            uint256 chainId,
            address venue,
            uint64 batchId,
            uint256 clearingPrice,
            uint256 matchedBase,
            Fill[] memory fills
        ) = abi.decode(_settlement, (uint256, address, uint64, uint256, uint256, Fill[]));

        // Domain binding: a settlement is valid for exactly one venue, on one
        // chain, for one batch.
        require(chainId == block.chainid, "wrong chain");
        require(venue == address(this), "wrong venue");
        if (batchSettled[batchId]) revert BatchAlreadySettled();

        _requireWithinBand(clearingPrice);

        int256 netBase;
        int256 netQuote;
        uint256 len = fills.length;
        for (uint256 i = 0; i < len; ++i) {
            netBase += fills[i].baseDelta;
            netQuote += fills[i].quoteDelta;
        }

        // Conservation is checked on the enclave's raw deltas, before any fee
        // is applied. Charging first could mask a batch that does not balance.
        require(netBase == 0, "base not conserved");
        require(netQuote == 0, "quote not conserved");

        uint256 totalFee;
        for (uint256 i = 0; i < len; ++i) {
            Fill memory f = fills[i];
            uint256 notional = f.quoteDelta >= 0 ? uint256(f.quoteDelta) : uint256(-f.quoteDelta);
            uint256 fee = (notional * feeBps) / 10000;
            totalFee += fee;

            // Both sides pay, and subtraction expresses it for either sign:
            // a seller (positive delta) receives less, a buyer (negative
            // delta) parts with more.
            _applyDelta(f.trader, f.baseDelta, f.quoteDelta - int256(fee));
        }

        if (totalFee > 0) {
            quoteBalance[feeRecipient] += totalFee;
            feesCollected += totalFee;
            emit FeeCharged(batchId, totalFee);
        }

        batchSettled[batchId] = true;
        currentBatchId = batchId + 1;

        batches[batchId] = BatchResult({
            clearingPrice: clearingPrice,
            matchedBase: matchedBase,
            feeCharged: totalFee,
            settledAt: uint64(block.timestamp),
            fillCount: uint32(len),
            orderCount: batchOrderCount[batchId]
        });

        emit BatchSettled(batchId, clearingPrice, matchedBase, len);
    }

    /// @notice Abandons the current batch without trading, releasing locked
    /// balances. Used when the enclave reports no cross or an out-of-band book.
    function cancelBatch() external onlyOwner {
        uint64 batchId = currentBatchId;
        batchSettled[batchId] = true;
        currentBatchId = batchId + 1;
        batches[batchId] = BatchResult({
            clearingPrice: 0,
            matchedBase: 0,
            feeCharged: 0,
            settledAt: uint64(block.timestamp),
            fillCount: 0,
            orderCount: batchOrderCount[batchId]
        });
        emit BatchSettled(batchId, 0, 0, 0);
    }

    // --- Internals ----------------------------------------------------------

    function _applyDelta(address _trader, int256 _baseDelta, int256 _quoteDelta) private {
        if (_baseDelta > 0) {
            baseBalance[_trader] += uint256(_baseDelta);
        } else if (_baseDelta < 0) {
            uint256 amount = uint256(-_baseDelta);
            if (baseBalance[_trader] < amount) revert InsufficientBalance();
            baseBalance[_trader] -= amount;
        }

        if (_quoteDelta > 0) {
            quoteBalance[_trader] += uint256(_quoteDelta);
        } else if (_quoteDelta < 0) {
            uint256 amount = uint256(-_quoteDelta);
            if (quoteBalance[_trader] < amount) revert InsufficientBalance();
            quoteBalance[_trader] -= amount;
        }
    }

    /// @notice Reads XRP/USD from the FTSO and scales it to PRICE_SCALE.
    function _referencePrice() private returns (uint256) {
        IFtsoV2 ftso = IFtsoV2(FLARE_REGISTRY.getContractAddressByName("FtsoV2"));
        (uint256 value, int8 decimals, uint64 timestamp) = ftso.getFeedById(XRP_USD_FEED_ID);
        if (timestamp + 1 hours < block.timestamp) revert StaleOracle();
        if (decimals >= 0) {
            // casting to 'uint8'/'uint256' is safe because the branch guarantees decimals >= 0
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 d = uint256(uint8(decimals));
            require(d <= 18, "feed decimals too large");
            return value * (10 ** (18 - d));
        }
        // Negative decimals mean the feed value is already scaled up.
        // casting to 'uint8'/'uint256' is safe because -decimals is positive in this branch
        // and int8 negation cannot exceed 128, well inside uint8
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 nd = uint256(uint8(-decimals));
        require(nd <= 18, "feed decimals too small");
        return value * PRICE_SCALE * (10 ** nd);
    }

    function _requireWithinBand(uint256 _clearingPrice) private {
        uint256 ref = _referencePrice();
        if (ref == 0) return;
        uint256 diff = _clearingPrice > ref ? _clearingPrice - ref : ref - _clearingPrice;
        if (diff * 10000 > ref * maxDeviationBps) revert ClearingPriceOutOfBand();
    }

    /// @dev Every instruction goes to as many enclaves as the threshold
    /// requires. Orders must reach all of them or their books would diverge and
    /// they could never agree on a settlement — so the fan-out applies to
    /// submissions, not only to clearing.
    function _send(bytes32 _opCommand, bytes memory _message) private {
        address[] memory teeIds =
            TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), signatureThreshold);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_AUCTION,
            opCommand: _opCommand,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{ value: msg.value }(teeIds, params);
    }

    /// @notice Checks that enough distinct registered enclaves signed exactly
    /// these settlement bytes.
    ///
    /// Signers must be strictly increasing by address. That is not cosmetic: it
    /// makes duplicates impossible to submit in O(n) without a nested loop, so
    /// one enclave cannot be counted twice toward the threshold.
    function _verifyQuorum(bytes calldata _settlement, bytes[] calldata _signatures) private view {
        if (_signatures.length < signatureThreshold) revert NotEnoughSignatures();

        bytes32 digest = _settlementDigest(_settlement);
        address previous = address(0);

        for (uint256 i = 0; i < _signatures.length; ++i) {
            address signer = _recover(digest, _signatures[i]);
            if (signer == address(0)) revert BadSignature();
            if (!isTee[signer]) revert UnknownSigner();
            if (signer <= previous) revert DuplicateSigner();
            previous = signer;
        }
    }

    /// @notice The digest the TEE actually signs.
    /// @dev The TEE node hashes the payload and then signs it through
    /// `accounts.TextHash`, so the signed digest carries the EIP-191 prefix:
    ///
    ///     keccak256("\x19Ethereum Signed Message:\n32" || keccak256(settlement))
    ///
    /// Recovering against the bare `keccak256(settlement)` yields an unrelated
    /// address and every settlement fails with BadSignature.
    function _settlementDigest(bytes calldata _settlement) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(_settlement)));
    }

    function _recover(bytes32 _digest, bytes calldata _signature) private pure returns (address) {
        if (_signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_signature.offset)
            s := calldataload(add(_signature.offset, 32))
            v := byte(0, calldataload(add(_signature.offset, 64)))
        }
        if (v < 27) v += 27;
        // Reject the malleable upper half of the curve order (secp256k1 n/2).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        return ecrecover(_digest, v, r, s);
    }

    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}
