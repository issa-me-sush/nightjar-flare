// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "./InstructionSender.sol";

/// @title TransparentVenue
/// @notice A conventional on-chain limit order book, included as the control in
/// a side-by-side comparison.
///
/// This is not a strawman. It is how an ordinary on-chain CLOB works: orders
/// rest in contract storage, so their side, price and size are readable by
/// anyone — through `getOrder`, through the emitted event, or straight out of
/// the calldata. Nothing here is deliberately weakened.
///
/// The point is what that visibility costs. A resting bid announces the most
/// its owner will pay, so a counterparty prices at that limit rather than at
/// the price the market would otherwise have cleared. The taker still gets a
/// fill; they just pay their whole limit instead of the clearing price. No
/// mempool games are required — reading public state is enough.
///
/// Run the same order flow through this and through NightjarAuction and the
/// difference is the cost of showing your hand.
contract TransparentVenue {
    IERC20 public immutable BASE_TOKEN;
    IERC20 public immutable QUOTE_TOKEN;

    uint256 public constant PRICE_SCALE = 1e18;

    struct Order {
        address trader;
        uint8 side; // 0 = buy base, 1 = sell base
        uint256 limitPrice; // quote per base, scaled by 1e18
        uint256 size; // base units
        bool filled;
    }

    /// @notice Every order, in the clear. This mapping is the whole problem.
    mapping(uint64 orderId => Order order) public orders;
    uint64 public nextOrderId = 1;

    mapping(address trader => uint256 amount) public baseBalance;
    mapping(address trader => uint256 amount) public quoteBalance;

    /// @notice Announces the order's exact terms to anyone watching.
    event OrderPosted(uint64 indexed orderId, address indexed trader, uint8 side, uint256 limitPrice, uint256 size);
    event OrderTaken(uint64 indexed orderId, address indexed taker, uint256 price, uint256 size);

    error AlreadyFilled();
    error NotCrossing();
    error InsufficientBalance();

    constructor(IERC20 _baseToken, IERC20 _quoteToken) {
        BASE_TOKEN = _baseToken;
        QUOTE_TOKEN = _quoteToken;
    }

    function deposit(uint256 _baseAmount, uint256 _quoteAmount) external {
        if (_baseAmount > 0) {
            require(BASE_TOKEN.transferFrom(msg.sender, address(this), _baseAmount), "base transfer failed");
            baseBalance[msg.sender] += _baseAmount;
        }
        if (_quoteAmount > 0) {
            require(QUOTE_TOKEN.transferFrom(msg.sender, address(this), _quoteAmount), "quote transfer failed");
            quoteBalance[msg.sender] += _quoteAmount;
        }
    }

    function withdraw(uint256 _baseAmount, uint256 _quoteAmount) external {
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
    }

    /// @notice Posts a resting order. Its terms are now public.
    function postOrder(uint8 _side, uint256 _limitPrice, uint256 _size) external returns (uint64) {
        uint64 orderId = nextOrderId++;
        orders[orderId] = Order({
            trader: msg.sender,
            side: _side,
            limitPrice: _limitPrice,
            size: _size,
            filled: false
        });
        emit OrderPosted(orderId, msg.sender, _side, _limitPrice, _size);
        return orderId;
    }

    /// @notice Reads an order's exact terms. Anyone may call this.
    function getOrder(uint64 _orderId) external view returns (Order memory) {
        return orders[_orderId];
    }

    /// @notice Fills a resting order at a price the taker chooses.
    ///
    /// The taker names the price, and the only constraint is that it respects
    /// the maker's stated limit. Having read that limit, a rational taker names
    /// exactly it — which is the entire point of this contract.
    function takeOrder(uint64 _orderId, uint256 _price) external {
        Order storage o = orders[_orderId];
        if (o.filled) revert AlreadyFilled();

        // The taker may not cross the maker's limit — but may sit right on it.
        if (o.side == 0) {
            if (_price > o.limitPrice) revert NotCrossing();
        } else {
            if (_price < o.limitPrice) revert NotCrossing();
        }

        uint256 quoteAmount = (o.size * _price) / PRICE_SCALE;

        if (o.side == 0) {
            // Maker buys base from the taker at the taker's chosen price.
            if (quoteBalance[o.trader] < quoteAmount) revert InsufficientBalance();
            if (baseBalance[msg.sender] < o.size) revert InsufficientBalance();
            quoteBalance[o.trader] -= quoteAmount;
            baseBalance[o.trader] += o.size;
            baseBalance[msg.sender] -= o.size;
            quoteBalance[msg.sender] += quoteAmount;
        } else {
            // Maker sells base to the taker.
            if (baseBalance[o.trader] < o.size) revert InsufficientBalance();
            if (quoteBalance[msg.sender] < quoteAmount) revert InsufficientBalance();
            baseBalance[o.trader] -= o.size;
            quoteBalance[o.trader] += quoteAmount;
            quoteBalance[msg.sender] -= quoteAmount;
            baseBalance[msg.sender] += o.size;
        }

        o.filled = true;
        emit OrderTaken(_orderId, msg.sender, _price, o.size);
    }
}
