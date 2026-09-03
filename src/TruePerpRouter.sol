// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

import {LendingVault} from "truelend/LendingVault.sol";
import {LiqRangeMath} from "truelend/libraries/LiqRangeMath.sol";
import {TruePerpHook} from "./TruePerpHook.sol";

/// @title TruePerpRouter
/// @notice Converts quote-denominated margin into physical, expiry-free long or
/// short positions. The router is intentionally stateless: all position and risk
/// state lives in TruePerpHook, while Uniswap flash accounting makes each open or
/// close atomic.
contract TruePerpRouter is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using SafeTransferLib for ERC20;
    using StateLibrary for IPoolManager;

    uint8 internal constant ACTION_OPEN = 1;
    uint8 internal constant ACTION_CLOSE = 2;
    uint256 internal constant BPS = 10_000;
    uint16 public constant PERP_MAX_LT_BPS = 9500;
    uint32 public constant PERPETUAL_HORIZON = type(uint32).max;

    IPoolManager public immutable poolManager;
    TruePerpHook public immutable hook;
    address public owner;

    uint256 internal locked = 1;

    struct Market {
        bool active;
        bool baseIs0;
    }

    mapping(PoolId => Market) internal markets;

    struct OpenParams {
        PoolKey key;
        bool isLong;
        uint256 margin; // always QUOTE
        uint256 borrowAmount; // QUOTE for longs; BASE for shorts
        uint16 liquidationThresholdBps;
        uint256 minSwapOutput;
        uint160 sqrtPriceLimitX96; // 0 selects the pool's absolute boundary
        uint256 deadline;
    }

    struct CloseParams {
        PoolKey key;
        bytes32 positionId;
        uint256 maxCollateralIn;
        uint160 sqrtPriceLimitX96; // 0 selects the pool's absolute boundary
        uint256 deadline;
    }

    /// @notice Spot-marked, quote-denominated position metrics. Leverage is
    /// directional: a long's exposure is its held BASE value, while a short's
    /// exposure is the value of the BASE it owes. This deliberately exposes the
    /// one-turn asymmetry between physically represented longs and shorts.
    struct PositionMetrics {
        bool isLong;
        uint256 collateralValueQuote;
        uint256 debtValueQuote;
        uint256 equityQuote;
        uint256 directionalNotionalQuote;
        uint256 leverageBps;
        uint256 ltvBps;
    }

    event PerpetualOpened(
        bytes32 indexed positionId,
        address indexed trader,
        bool indexed isLong,
        uint256 margin,
        uint256 borrowed,
        uint256 physicalCollateral
    );
    event PerpetualClosed(
        bytes32 indexed positionId, address indexed trader, uint256 collateralSold, uint256 debtPurchased
    );
    event MarketActivated(PoolId indexed poolId, address indexed base, address indexed quote);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    error Reentrancy();
    error NotOwner();
    error NotPoolManager();
    error UnknownAction();
    error DeadlineExpired();
    error MarketNotActive();
    error ZeroAmount();
    error PartialInputSwap();
    error TooLittleSwapOutput();
    error NotPositionOwner();
    error TooMuchCollateralRequired();
    error IncompleteDebtPurchase();
    error AmountTooLarge();
    error WrongPool();
    error PoolNotInitialized();
    error MarketAlreadyActive();
    error InvalidBaseCurrency();
    error NativeCurrencyUnsupported();
    error PerpetualHorizonNotConfigured();
    error ZeroAddress();
    error InvalidPoolManager();
    error MissingSlippageProtection();
    error NonZeroCarryUnsupported();
    error PositionNotActive();
    error NoPositiveEquity();
    error LtExceedsPerpetualMarketPolicy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolManager manager, TruePerpHook hook_, address owner_) {
        if (owner_ == address(0) || address(manager) == address(0) || address(hook_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(hook_.poolManager()) != address(manager)) revert InvalidPoolManager();
        poolManager = manager;
        hook = hook_;
        owner = owner_;
    }

    /// @notice Add BASE/QUOTE semantics after the hook owner has configured the
    /// maximum uint32 term on the underlying pool. This is TruePerp's explicit
    /// no-scheduled-expiry sentinel (~136 years) while reusing TrueLend's compact
    /// position layout unchanged.
    function activateMarket(PoolKey calldata key, Currency base) external onlyOwner {
        PoolId poolId = key.toId();
        (LendingVault vault0, LendingVault vault1,, bool enabled) = hook.getPool(poolId);
        if (!enabled) revert PoolNotInitialized();
        if (markets[poolId].active) revert MarketAlreadyActive();
        if (key.currency0.isAddressZero() || key.currency1.isAddressZero()) revert NativeCurrencyUnsupported();
        if (vault0.rateCeilingBps() != 0 || vault1.rateCeilingBps() != 0) {
            revert NonZeroCarryUnsupported();
        }
        if (hook.getConfig(poolId).termSeconds != PERPETUAL_HORIZON) {
            revert PerpetualHorizonNotConfigured();
        }

        address baseAddress = Currency.unwrap(base);
        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        if (baseAddress != currency0 && baseAddress != currency1) revert InvalidBaseCurrency();

        bool baseIs0 = baseAddress == currency0;
        markets[poolId] = Market({active: true, baseIs0: baseIs0});
        emit MarketActivated(poolId, baseAddress, baseIs0 ? currency1 : currency0);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function getMarket(PoolId poolId) external view returns (bool active, bool baseIs0) {
        Market storage market = markets[poolId];
        return (market.active, market.baseIs0);
    }

    /// @notice Return current directional leverage and LTV at the pool's spot
    /// price. These are display metrics, not admission values: `open` continues
    /// to use TrueLend's manipulation-resistant borrower-adverse oracle.
    function getPositionMetrics(PoolKey calldata key, bytes32 positionId)
        external
        view
        returns (PositionMetrics memory metrics)
    {
        TruePerpHook.Position memory position = hook.getPosition(positionId);
        if (position.borrower == address(0)) revert PositionNotActive();

        PoolId poolId = key.toId();
        if (PoolId.unwrap(poolId) != PoolId.unwrap(position.poolId)) revert WrongPool();
        Market memory market = _activeMarket(poolId);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);

        uint256 debt = hook.debtOf(positionId);
        metrics.isLong = position.collateralIs0 == market.baseIs0;
        if (metrics.isLong) {
            metrics.collateralValueQuote =
                LiqRangeMath.convertAtSqrtPrice(position.collateral, sqrtPriceX96, market.baseIs0);
            metrics.debtValueQuote = debt;
            metrics.directionalNotionalQuote = metrics.collateralValueQuote;
        } else {
            metrics.collateralValueQuote = position.collateral;
            metrics.debtValueQuote = LiqRangeMath.convertAtSqrtPrice(debt, sqrtPriceX96, market.baseIs0);
            metrics.directionalNotionalQuote = metrics.debtValueQuote;
        }

        if (metrics.debtValueQuote >= metrics.collateralValueQuote) revert NoPositiveEquity();
        metrics.equityQuote = metrics.collateralValueQuote - metrics.debtValueQuote;
        metrics.leverageBps = FullMath.mulDiv(metrics.directionalNotionalQuote, BPS, metrics.equityQuote);
        metrics.ltvBps = FullMath.mulDiv(metrics.debtValueQuote, BPS, metrics.collateralValueQuote);
    }

    /// @notice Open a physical long or short using QUOTE margin.
    ///
    /// Long: (margin QUOTE + borrowed QUOTE) -> BASE collateral.
    /// Short: borrowed BASE -> QUOTE, then sale proceeds + margin become
    ///        QUOTE collateral.
    function openPosition(OpenParams calldata p) external nonReentrant returns (bytes32 positionId) {
        if (block.timestamp > p.deadline) revert DeadlineExpired();
        if (p.margin == 0 || p.borrowAmount == 0) revert ZeroAmount();
        if (p.minSwapOutput == 0) revert MissingSlippageProtection();
        if (p.liquidationThresholdBps > PERP_MAX_LT_BPS) revert LtExceedsPerpetualMarketPolicy();
        uint256 maxSwapAmount = uint256(uint128(type(int128).max));
        if (p.borrowAmount > maxSwapAmount || p.margin > maxSwapAmount - p.borrowAmount) {
            revert AmountTooLarge();
        }

        PoolId poolId = p.key.toId();
        Market memory market = _activeMarket(poolId);
        if (hook.getConfig(poolId).termSeconds != PERPETUAL_HORIZON) {
            revert PerpetualHorizonNotConfigured();
        }
        Currency quoteCurrency = market.baseIs0 ? p.key.currency1 : p.key.currency0;
        ERC20 quote = ERC20(Currency.unwrap(quoteCurrency));

        quote.safeTransferFrom(msg.sender, address(this), p.margin);
        positionId = abi.decode(poolManager.unlock(abi.encode(ACTION_OPEN, msg.sender, abi.encode(p))), (bytes32));
    }

    /// @notice Close a position by flash-repaying its debt and buying that debt
    /// back with the returned physical collateral. The trader keeps all unused
    /// collateral, so longs settle to BASE and shorts settle to QUOTE.
    /// @dev The trader must approve this router for up to maxCollateralIn.
    function closePosition(CloseParams calldata p) external nonReentrant {
        if (block.timestamp > p.deadline) revert DeadlineExpired();
        if (p.maxCollateralIn == 0) revert ZeroAmount();

        TruePerpHook.Position memory position = hook.getPosition(p.positionId);
        if (position.borrower != msg.sender) revert NotPositionOwner();
        if (PoolId.unwrap(p.key.toId()) != PoolId.unwrap(position.poolId)) revert WrongPool();
        _activeMarket(position.poolId);

        Currency debtCurrency = position.collateralIs0 ? p.key.currency1 : p.key.currency0;
        ERC20 debtAsset = ERC20(Currency.unwrap(debtCurrency));
        uint256 debtBalanceBefore = debtAsset.balanceOf(address(this));

        poolManager.unlock(abi.encode(ACTION_CLOSE, msg.sender, abi.encode(p)));

        // repay() may refund one rounding wei. It belongs to this close's trader.
        uint256 debtBalanceAfter = debtAsset.balanceOf(address(this));
        if (debtBalanceAfter > debtBalanceBefore) {
            debtAsset.safeTransfer(msg.sender, debtBalanceAfter - debtBalanceBefore);
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, address trader, bytes memory inner) = abi.decode(data, (uint8, address, bytes));
        if (action == ACTION_OPEN) {
            return abi.encode(_open(trader, abi.decode(inner, (OpenParams))));
        }
        if (action == ACTION_CLOSE) {
            _close(trader, abi.decode(inner, (CloseParams)));
            return "";
        }
        revert UnknownAction();
    }

    function _open(address trader, OpenParams memory p) internal returns (bytes32 positionId) {
        PoolId poolId = p.key.toId();
        Market memory market = _activeMarket(poolId);
        bool baseIs0 = market.baseIs0;
        ERC20 base = ERC20(Currency.unwrap(baseIs0 ? p.key.currency0 : p.key.currency1));
        ERC20 quote = ERC20(Currency.unwrap(baseIs0 ? p.key.currency1 : p.key.currency0));

        bool collateralIs0 = p.isLong ? baseIs0 : !baseIs0;
        Currency collateralCurrency = collateralIs0 ? p.key.currency0 : p.key.currency1;
        Currency debtCurrency = collateralIs0 ? p.key.currency1 : p.key.currency0;
        ERC20 collateralAsset = p.isLong ? base : quote;

        uint256 swapInput = p.isLong ? p.margin + p.borrowAmount : p.borrowAmount;
        if (swapInput > uint256(uint128(type(int128).max))) revert AmountTooLarge();
        bool zeroForOne = !collateralIs0;
        BalanceDelta delta = poolManager.swap(
            p.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(swapInput),
                sqrtPriceLimitX96: p.sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
                    : p.sqrtPriceLimitX96
            }),
            ""
        );

        uint256 consumed = uint256(uint128(-(zeroForOne ? delta.amount0() : delta.amount1())));
        uint256 swapOutput = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
        if (consumed != swapInput) revert PartialInputSwap();
        if (swapOutput < p.minSwapOutput) revert TooLittleSwapOutput();

        collateralCurrency.take(poolManager, address(this), swapOutput, false);
        uint256 physicalCollateral = p.isLong ? swapOutput : p.margin + swapOutput;
        collateralAsset.safeApprove(address(hook), physicalCollateral);
        positionId =
            hook.open(p.key, collateralIs0, physicalCollateral, p.borrowAmount, p.liquidationThresholdBps, trader);

        // The hook just borrowed this amount to the router. Together with the
        // trader's margin on a long, it settles the swap's exact input.
        debtCurrency.settle(poolManager, address(this), swapInput, false);

        emit PerpetualOpened(positionId, trader, p.isLong, p.margin, p.borrowAmount, physicalCollateral);
    }

    function _close(address trader, CloseParams memory p) internal {
        TruePerpHook.Position memory position = hook.getPosition(p.positionId);
        if (position.borrower != trader) revert NotPositionOwner();

        Currency collateralCurrency = position.collateralIs0 ? p.key.currency0 : p.key.currency1;
        Currency debtCurrency = position.collateralIs0 ? p.key.currency1 : p.key.currency0;
        ERC20 collateralAsset = ERC20(Currency.unwrap(collateralCurrency));
        ERC20 debtAsset = ERC20(Currency.unwrap(debtCurrency));

        // One extra wei guarantees all debt shares burn despite two floor-rounding
        // conversions. Any unused wei is refunded to the trader by closePosition.
        uint256 debtToPurchase = hook.debtOf(p.positionId) + 1;
        if (debtToPurchase > uint256(uint128(type(int128).max))) revert AmountTooLarge();
        debtCurrency.take(poolManager, address(this), debtToPurchase, false);
        debtAsset.safeApprove(address(hook), debtToPurchase);
        hook.repay(p.positionId, debtToPurchase);

        bool zeroForOne = position.collateralIs0;
        BalanceDelta delta = poolManager.swap(
            p.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(debtToPurchase),
                sqrtPriceLimitX96: p.sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
                    : p.sqrtPriceLimitX96
            }),
            ""
        );

        uint256 collateralRequired = uint256(uint128(-(zeroForOne ? delta.amount0() : delta.amount1())));
        uint256 debtPurchased = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
        if (debtPurchased < debtToPurchase) revert IncompleteDebtPurchase();
        if (collateralRequired > p.maxCollateralIn) revert TooMuchCollateralRequired();

        collateralAsset.safeTransferFrom(trader, address(this), collateralRequired);
        collateralCurrency.settle(poolManager, address(this), collateralRequired, false);

        emit PerpetualClosed(p.positionId, trader, collateralRequired, debtPurchased);
    }

    function _activeMarket(PoolId poolId) internal view returns (Market memory market) {
        market = markets[poolId];
        if (!market.active) revert MarketNotActive();
    }
}
