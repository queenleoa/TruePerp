// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {LiqRangeMath} from "truelend/libraries/LiqRangeMath.sol";
import {ChunkMath} from "truelend/libraries/ChunkMath.sol";
import {TruncatedOracle} from "truelend/libraries/TruncatedOracle.sol";
import {TriggerIndex} from "truelend/libraries/TriggerIndex.sol";

import {PerpVault} from "./PerpVault.sol";
import {PerpVaultFactory} from "./PerpVaultFactory.sol";

/// @title TruePerpHook
/// @notice An oracleless, cash-settled perpetual on Uniswap v4, built as a
/// SIBLING of TrueLend (RESEARCH.md appendix, path 2): same venue-as-oracle
/// stance, same gradual/reversible/chunked liquidation kernel — reused through
/// TrueLend's linked libraries — applied to margin trading instead of loans.
///
/// The mapping from lending to perps (one line each):
///   collateral -> margin (cash, custodied by the hook)
///   debt       -> notional base exposure against the PerpVault (the LP house)
///   LT gap     -> maintenance margin; liquidation range = [maintenance, bankruptcy]
///   chunk sale -> chunked auto-deleveraging: notional shrinks step by step,
///                 realizing PnL against margin at the pool's own price; price
///                 recovery pauses it, exactly like a loan's decay
///   penalty to in-range LPs -> penalty to vault LPs (the counterparty absorbers)
///   interest  -> funding: OI skew prices the rate, no funding oracle
///
/// The spot pool the hook attaches to provides the price (its tick), the ADL
/// pacing clock (its swaps), and the manipulation filter (TrueLend's truncated
/// oracle). The hook never swaps: settlement is pure cash bookkeeping between
/// trader margin (held here) and the PerpVault, so no unlock is ever needed.
///
/// Cash is ALWAYS currency1 (native currency sorts to currency0, so the cash
/// side is always ERC-20). Base = currency0.
contract TruePerpHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;
    using TruncatedOracle for TruncatedOracle.State;
    using TriggerIndex for TriggerIndex.State;

    // ------------------------------------------------------------------ constants

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_CHUNKS_PER_SWAP = 2;
    uint256 internal constant MAX_CHUNKS_PER_POKE = 10;
    uint256 internal constant MAX_TRIGGERS_PER_WALK = 8;
    uint256 internal constant MAX_REFRESHES_PER_WALK = 32;

    // ------------------------------------------------------------------ types

    struct Config {
        uint16 maintenanceMarginBps; // m: liquidation range starts at equity = m * notional
        uint16 initialMarginBps; // >= 2*m; max leverage = 1e4 / initialMarginBps
        uint16 basePenaltyBps; // per-chunk penalty on closed notional (time-scaled)
        uint16 openFeeBps;
        uint16 closeFeeBps;
        uint16 rewardBps; // poke/forceClose executor reward, carved from the penalty
        uint16 maxChunkDepthBps; // per-chunk cap as bps of in-range base depth
        uint16 targetChunks;
        uint32 chunkInterval;
        uint8 timeCapX;
        uint32 fundingKBps; // annualized funding rate at 100% skew, in bps
        uint16 oiCapBps; // total open notional <= vault equity * oiCapBps / 1e4
        uint128 minMargin;
    }

    struct Market {
        PoolKey key;
        PerpVault vault;
        bool enabled;
        int24 processedTick;
        uint128 baseLong; // Σ open long base (1e18 units)
        uint128 baseShort;
        uint256 costLong; // Σ entry * base / 1e18, cash units
        uint256 costShort;
        int256 cumFundingLong; // cash per 1e18 base, cumulative; longs pay when rising
        int256 cumFundingShort;
        uint64 lastFunding;
    }

    struct Position {
        address trader;
        PoolId poolId;
        bool isLong;
        bool inQueue;
        uint128 margin; // cash, custodied by this hook
        uint128 baseSize; // 1e18 base units of exposure
        uint128 entryPrice; // cash per 1e18 base
        int256 fundingSnap;
        int24 tickStart; // ADL range: maintenance boundary
        int24 tickEnd; // bankruptcy boundary
        uint40 lastChunkAt;
        uint40 liqStartedAt;
        uint40 timeInLiqAccrued;
    }

    // ------------------------------------------------------------------ storage

    address public owner;
    PerpVaultFactory public immutable vaultFactory;

    mapping(PoolId => Market) internal markets;
    mapping(PoolId => Config) internal configs;
    mapping(PoolId => TruncatedOracle.State) internal oracles;
    mapping(PoolId => TriggerIndex.State) internal triggers;
    mapping(PoolId => bytes32[]) internal liqQueue;
    mapping(PoolId => uint256) internal queueCursor;
    mapping(bytes32 => Position) internal positions;
    uint256 internal positionNonce;
    uint256 internal locked = 1;

    // ------------------------------------------------------------------ events / errors

    event MarketEnabled(PoolId indexed poolId, address vault);
    event PositionOpened(
        bytes32 indexed positionId,
        address indexed trader,
        PoolId indexed poolId,
        bool isLong,
        uint256 margin,
        uint256 baseSize,
        uint256 entryPrice,
        int24 tickStart,
        int24 tickEnd
    );
    event AdlStarted(bytes32 indexed positionId, int24 tick);
    event AdlPaused(bytes32 indexed positionId, int24 tick, uint256 episodeSeconds);
    event ChunkDeleveraged(
        bytes32 indexed positionId, uint256 baseClosed, uint256 lossRealized, uint256 penalty
    );
    event FundingAccrued(PoolId indexed poolId, int256 deltaPerBase, uint256 residualToVault);
    event PositionClosed(
        bytes32 indexed positionId, address indexed closer, uint8 kind, uint256 payout, uint256 shortfall
    ); // kind: 0 trader · 1 decay complete · 2 backstop

    error NotOwner();
    error Reentrancy();
    error MarketNotEnabled();
    error OracleNotReady();
    error AmountTooSmall();
    error OverLeveraged();
    error OpenInterestCapExceeded();
    error PositionNotActive();
    error NotTrader();
    error NotEligibleForForceClose();
    error FullyBackedPosition();
    error BadConfig();

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

    constructor(IPoolManager _poolManager, PerpVaultFactory _factory, address _owner) BaseHook(_poolManager) {
        owner = _owner;
        vaultFactory = _factory;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------ hook callbacks

    function _afterInitialize(address, PoolKey calldata key, uint160, int24 tick) internal override returns (bytes4) {
        PoolId poolId = key.toId();
        ERC20 cash = ERC20(Currency.unwrap(key.currency1)); // never native (sorting)
        PerpVault vault = vaultFactory.deploy(cash, address(this), poolId);

        markets[poolId] = Market({
            key: key,
            vault: vault,
            enabled: true,
            processedTick: tick,
            baseLong: 0,
            baseShort: 0,
            costLong: 0,
            costShort: 0,
            cumFundingLong: 0,
            cumFundingShort: 0,
            lastFunding: uint64(block.timestamp)
        });
        configs[poolId] = Config({
            maintenanceMarginBps: 200, // 2% — LT 98 analog
            initialMarginBps: 500, // 20x max leverage
            basePenaltyBps: 50,
            openFeeBps: 10,
            closeFeeBps: 10,
            rewardBps: 10,
            maxChunkDepthBps: 100,
            targetChunks: 100,
            chunkInterval: 60,
            timeCapX: 5,
            fundingKBps: 10_000, // 100%/yr at full skew ≈ 0.011%/h
            oiCapBps: 5000, // open notional ≤ 50% of LP equity
            minMargin: 0
        });
        oracles[poolId].initialize(tick, uint32(block.timestamp));
        emit MarketEnabled(poolId, address(vault));
        return BaseHook.afterInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(poolId);
        oracles[poolId].observe(tick, uint32(block.timestamp));
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        _drive(key.toId(), MAX_CHUNKS_PER_SWAP, address(0));
        return (BaseHook.afterSwap.selector, 0);
    }

    // ------------------------------------------------------------------ trader entrypoints

    /// @notice Open a cash-settled position. Margin is pulled from the trader and
    /// custodied by the hook; the entry prices at the WORSE of spot and the
    /// truncated filter for the chosen side, so flash moves cannot cheapen entries.
    function openPosition(PoolKey calldata key, bool isLong, uint128 margin, uint128 baseSize)
        external
        nonReentrant
        returns (bytes32 positionId)
    {
        PoolId poolId = key.toId();
        Market storage m = markets[poolId];
        Config memory cfg = configs[poolId];
        if (!m.enabled) revert MarketNotEnabled();
        if (!oracles[poolId].ready()) revert OracleNotReady();
        if (margin == 0 || baseSize == 0 || margin < cfg.minMargin) revert AmountTooSmall();

        _accrueFunding(poolId);

        // adverse entry: long enters HIGH, short enters LOW (worse-of filter).
        // base = token0, so a high base price is a high tick.
        (, int24 spotTick,,) = poolManager.getSlot0(poolId);
        uint128 entry = uint128(_priceAtTick(oracles[poolId].borrowTick(spotTick, !isLong)));

        uint256 notional = FullMath.mulDiv(baseSize, entry, WAD);
        if (uint256(margin) * BPS < notional * cfg.initialMarginBps) revert OverLeveraged();
        uint256 openInterest = FullMath.mulDiv(m.baseLong + m.baseShort + baseSize, entry, WAD);
        if (openInterest * BPS > uint256(cfg.oiCapBps) * m.vault.equity()) revert OpenInterestCapExceeded();

        // fee out of margin, to the LPs taking the other side
        uint256 fee = notional * cfg.openFeeBps / BPS;
        if (fee >= margin) revert AmountTooSmall();
        ERC20 cash = ERC20(Currency.unwrap(key.currency1));
        cash.safeTransferFrom(msg.sender, address(this), margin);
        cash.safeTransfer(address(m.vault), fee);
        uint128 marginNet = margin - uint128(fee);

        (int24 tickStart, int24 tickEnd) =
            _adlRange(isLong, entry, baseSize, marginNet, cfg.maintenanceMarginBps, key.tickSpacing);

        positionId = keccak256(abi.encodePacked(msg.sender, PoolId.unwrap(poolId), positionNonce++));
        positions[positionId] = Position({
            trader: msg.sender,
            poolId: poolId,
            isLong: isLong,
            inQueue: false,
            margin: marginNet,
            baseSize: baseSize,
            entryPrice: entry,
            fundingSnap: isLong ? m.cumFundingLong : m.cumFundingShort,
            tickStart: tickStart,
            tickEnd: tickEnd,
            lastChunkAt: 0,
            liqStartedAt: 0,
            timeInLiqAccrued: 0
        });
        if (isLong) {
            m.baseLong += baseSize;
            m.costLong += FullMath.mulDiv(baseSize, entry, WAD);
        } else {
            m.baseShort += baseSize;
            m.costShort += FullMath.mulDiv(baseSize, entry, WAD);
        }
        triggers[poolId].register(tickStart, key.tickSpacing, positionId);
        triggers[poolId].register(tickEnd, key.tickSpacing, positionId);

        emit PositionOpened(positionId, msg.sender, poolId, isLong, marginNet, baseSize, entry, tickStart, tickEnd);
        _refresh(positionId, spotTick);
    }

    /// @notice Close your own position in full, at the worse-of exit price for
    /// your side (longs exit low, shorts exit high — same filter as entry).
    function closePosition(bytes32 positionId) external nonReentrant {
        Position storage pos = positions[positionId];
        if (pos.trader == address(0)) revert PositionNotActive();
        if (pos.trader != msg.sender) revert NotTrader();
        _accrueFunding(pos.poolId);
        _settleFunding(pos);

        (, int24 spotTick,,) = poolManager.getSlot0(pos.poolId);
        uint256 exitP = _priceAtTick(oracles[pos.poolId].borrowTick(spotTick, pos.isLong));
        _closeAt(positionId, exitP, configs[pos.poolId].closeFeeBps, 0, address(0), 0);
    }

    /// @notice Execute pending ADL chunks without waiting for a swap; the caller
    /// is paid from the penalty flow. No PoolManager unlock is needed — perp
    /// settlement is pure cash bookkeeping.
    function poke(PoolKey calldata key) external nonReentrant {
        PoolId poolId = key.toId();
        if (!markets[poolId].enabled) revert MarketNotEnabled();
        _drive(poolId, MAX_CHUNKS_PER_POKE, msg.sender);
    }

    /// @notice Hard backstop: 1 = bankruptcy boundary crossed, 2 = equity gone at
    /// the current filtered price. Anyone may close; reward carved from the penalty.
    function forceClose(bytes32 positionId) external nonReentrant {
        Position storage pos = positions[positionId];
        if (pos.trader == address(0)) revert PositionNotActive();
        _accrueFunding(pos.poolId);
        _settleFunding(pos);
        uint8 reason = _forceCloseReason(positionId);
        if (reason == 0) revert NotEligibleForForceClose();

        (, int24 spotTick,,) = poolManager.getSlot0(pos.poolId);
        uint256 exitP = _priceAtTick(oracles[pos.poolId].borrowTick(spotTick, pos.isLong));
        Config memory cfg = configs[pos.poolId];
        _closeAt(positionId, exitP, 0, _currentPenaltyBps(pos, cfg), msg.sender, cfg.rewardBps);
    }

    function forceCloseReason(bytes32 positionId) external view returns (uint8) {
        return _forceCloseReason(positionId);
    }

    // ------------------------------------------------------------------ funding

    /// dFunding = P_median · k · skew · dt/YEAR per 1e18 base. Longs pay when
    /// long OI dominates; shorts pay when short OI dominates; the residual of
    /// the imbalanced leg accrues to the vault.
    function _accrueFunding(PoolId poolId) internal {
        Market storage m = markets[poolId];
        uint256 dt = block.timestamp - m.lastFunding;
        if (dt == 0) return;
        m.lastFunding = uint64(block.timestamp);
        uint256 L = m.baseLong;
        uint256 S = m.baseShort;
        if (L + S == 0) return;

        uint256 p = _priceAtTick(oracles[poolId].medianTick());
        Config memory cfg = configs[poolId];
        int256 skewSigned = (int256(L) - int256(S)) * 1e18 / int256(L + S);
        int256 delta = int256(FullMath.mulDiv(p, cfg.fundingKBps * dt, BPS * YEAR));
        delta = delta * skewSigned / 1e18;
        if (delta == 0) return;

        m.cumFundingLong += delta;
        m.cumFundingShort -= delta; // symmetric: the paying side's cum rises for it
        uint256 residual = FullMath.mulDiv(_abs(delta), L > S ? L - S : S - L, WAD);
        if (residual > 0) {
            // the imbalanced remainder is backed by trader margins held here
            ERC20(Currency.unwrap(m.key.currency1)).safeTransfer(address(m.vault), residual);
        }
        emit FundingAccrued(poolId, delta, residual);
    }

    function _settleFunding(Position storage pos) internal {
        Market storage m = markets[pos.poolId];
        int256 cum = pos.isLong ? m.cumFundingLong : m.cumFundingShort;
        int256 owed = (cum - pos.fundingSnap) * int256(uint256(pos.baseSize)) / int256(WAD);
        pos.fundingSnap = cum;
        if (owed > 0) {
            uint256 o = uint256(owed);
            pos.margin = o >= pos.margin ? 0 : pos.margin - uint128(o);
        } else if (owed < 0) {
            pos.margin += uint128(uint256(-owed));
        }
    }

    // ------------------------------------------------------------------ chunked ADL

    function _drive(PoolId poolId, uint256 maxChunks, address rewardTo) internal {
        _accrueFunding(poolId);
        _walkTriggers(poolId);
        _processQueue(poolId, maxChunks, rewardTo);
        _walkTriggers(poolId);
    }

    function _walkTriggers(PoolId poolId) internal {
        Market storage m = markets[poolId];
        (, int24 tick,,) = poolManager.getSlot0(poolId);
        int24 from = m.processedTick;
        if (tick == from) return;
        bool up = tick > from;

        (int24[] memory crossed, uint256 n, int24 walkedTo) =
            triggers[poolId].crossedTriggers(from, tick, m.key.tickSpacing, MAX_TRIGGERS_PER_WALK);
        uint256 budget = MAX_REFRESHES_PER_WALK;
        for (uint256 i = 0; i < n; i++) {
            bytes32[] storage ids = triggers[poolId].idsAtTick(crossed[i]);
            uint256 cnt = ids.length;
            if (cnt > budget) {
                m.processedTick = up ? crossed[i] - 1 : crossed[i] + 1;
                return;
            }
            for (uint256 j = 0; j < cnt; j++) {
                _refresh(ids[j], tick);
            }
            budget -= cnt;
        }
        m.processedTick = walkedTo;
    }

    function _refresh(bytes32 positionId, int24 tick) internal {
        Position storage pos = positions[positionId];
        if (pos.trader == address(0)) return;
        bool inR = LiqRangeMath.inRange(pos.isLong, tick, pos.tickStart, pos.tickEnd);
        if (inR && pos.liqStartedAt == 0) {
            pos.liqStartedAt = uint40(block.timestamp);
            pos.lastChunkAt = uint40(block.timestamp - configs[pos.poolId].chunkInterval);
            if (!pos.inQueue) {
                pos.inQueue = true;
                liqQueue[pos.poolId].push(positionId);
            }
            emit AdlStarted(positionId, tick);
        } else if (!inR && pos.liqStartedAt != 0) {
            uint256 episode = block.timestamp - pos.liqStartedAt;
            pos.timeInLiqAccrued += uint40(episode);
            pos.liqStartedAt = 0;
            emit AdlPaused(positionId, tick, episode);
        }
    }

    function _processQueue(PoolId poolId, uint256 maxChunks, address rewardTo) internal {
        bytes32[] storage queue = liqQueue[poolId];
        uint256 executed;
        uint256 scanned;
        uint256 maxScan = maxChunks * 3 + 2;
        while (executed < maxChunks && scanned < maxScan && queue.length > 0) {
            uint256 cursor = queueCursor[poolId];
            if (cursor >= queue.length) cursor = 0;
            bytes32 positionId = queue[cursor];
            Position storage pos = positions[positionId];
            scanned++;
            if (pos.trader == address(0) || pos.liqStartedAt == 0) {
                pos.inQueue = false;
                queue[cursor] = queue[queue.length - 1];
                queue.pop();
                continue;
            }
            if (_executeChunk(positionId, rewardTo)) executed++;
            queueCursor[poolId] = cursor + 1;
        }
    }

    /// @dev One paced ADL step: close `chunk` of base exposure at the pool's own
    /// price, realize the loss against margin, pay the penalty to the vault LPs
    /// (reward carved out first). Cash-settled — no swap, no market impact beyond
    /// what the price has already done.
    function _executeChunk(bytes32 positionId, address rewardTo) internal returns (bool) {
        Position storage pos = positions[positionId];
        PoolId poolId = pos.poolId;
        Market storage m = markets[poolId];
        Config memory cfg = configs[poolId];
        (, int24 tick,,) = poolManager.getSlot0(poolId);

        uint256 depthBase = LiqRangeMath.rangeDepthTokens(
            true, pos.tickStart, pos.tickEnd, poolManager.getLiquidity(poolId)
        ); // base = token0
        if (depthBase == 0) return false;

        uint256 p = _priceAtTick(tick);

        // deleveraging restores health: every chunk shrinks notional faster than
        // it burns margin, so equity eventually covers maintenance on what's left.
        // That is the perp analog of TrueLend's decay terminating at debt = 0 —
        // stop the episode there, don't grind the position to dust.
        {
            uint256 notionalNow = FullMath.mulDiv(pos.baseSize, p, WAD);
            uint256 unrealLoss = pos.isLong
                ? FullMath.mulDiv(pos.baseSize, pos.entryPrice > p ? pos.entryPrice - p : 0, WAD)
                : FullMath.mulDiv(pos.baseSize, p > pos.entryPrice ? p - pos.entryPrice : 0, WAD);
            if (
                uint256(pos.margin) > unrealLoss
                    && (uint256(pos.margin) - unrealLoss) * BPS >= notionalNow * cfg.maintenanceMarginBps
            ) {
                uint256 episode = block.timestamp - pos.liqStartedAt;
                pos.timeInLiqAccrued += uint40(episode);
                pos.liqStartedAt = 0; // healthy again: pause; lazy-dequeued next pass
                emit AdlPaused(positionId, tick, episode);
                return false;
            }
        }

        uint256 chunk = ChunkMath.chunkSize(
            ChunkMath.Params({
                remaining: pos.baseSize,
                targetChunks: cfg.targetChunks,
                elapsed: block.timestamp - pos.lastChunkAt,
                interval: cfg.chunkInterval,
                timeCapX: cfg.timeCapX,
                depthBps: LiqRangeMath.depthBps(pos.isLong, tick, pos.tickStart, pos.tickEnd),
                pressureBps: FullMath.mulDiv(pos.baseSize, BPS, depthBase),
                minChunk: 0,
                maxChunk: FullMath.mulDiv(depthBase, cfg.maxChunkDepthBps, BPS)
            })
        );
        if (chunk == 0) return false;

        _settleFunding(pos);
        pos.lastChunkAt = uint40(block.timestamp);
        // inside the range price is adverse to the position by construction
        uint256 loss = pos.isLong
            ? FullMath.mulDiv(chunk, pos.entryPrice > p ? pos.entryPrice - p : 0, WAD)
            : FullMath.mulDiv(chunk, p > pos.entryPrice ? p - pos.entryPrice : 0, WAD);
        uint256 penalty = FullMath.mulDiv(FullMath.mulDiv(chunk, p, WAD), _currentPenaltyBps(pos, cfg), BPS);
        uint256 reward;
        if (rewardTo != address(0) && cfg.rewardBps > 0) {
            reward = FullMath.mulDiv(FullMath.mulDiv(chunk, p, WAD), cfg.rewardBps, BPS);
            if (reward > penalty) reward = penalty;
            penalty -= reward;
        }

        uint256 charge = loss + penalty + reward;
        ERC20 cash = ERC20(Currency.unwrap(m.key.currency1));
        if (charge >= pos.margin) {
            // margin exhausted mid-decay: backstop the remainder right here
            _backstopRemainder(positionId, p, rewardTo, reward, penalty, loss, chunk);
            return true;
        }
        pos.margin -= uint128(charge);
        pos.baseSize -= uint128(chunk);
        _reduceAggregates(m, pos.isLong, chunk, pos.entryPrice);
        if (penalty + loss > 0) cash.safeTransfer(address(m.vault), penalty + loss);
        if (reward > 0) cash.safeTransfer(rewardTo, reward);
        emit ChunkDeleveraged(positionId, chunk, loss, penalty);

        if (pos.baseSize == 0) {
            address trader = pos.trader;
            uint256 marginBack = pos.margin;
            _deletePosition(positionId);
            if (marginBack > 0) cash.safeTransfer(trader, marginBack);
            emit PositionClosed(positionId, address(0), 1, marginBack, 0);
        }
        return true;
    }

    // ------------------------------------------------------------------ closing

    /// @dev Close the whole position at `exitP`. Fees/penalties on notional;
    /// executor reward carved from the penalty. Positive equity pays the trader
    /// (wins funded by the vault); negative equity is a recorded LP shortfall.
    function _closeAt(
        bytes32 positionId,
        uint256 exitP,
        uint16 feeBps,
        uint256 penaltyBps_,
        address rewardTo,
        uint16 rewardBps
    ) internal {
        Position storage pos = positions[positionId];
        Market storage m = markets[pos.poolId];
        ERC20 cash = ERC20(Currency.unwrap(m.key.currency1));

        uint256 notional = FullMath.mulDiv(pos.baseSize, exitP, WAD);
        int256 pnl = pos.isLong
            ? (int256(notional) - int256(FullMath.mulDiv(pos.baseSize, pos.entryPrice, WAD)))
            : (int256(FullMath.mulDiv(pos.baseSize, pos.entryPrice, WAD)) - int256(notional));
        uint256 penalty = notional * penaltyBps_ / BPS;
        uint256 reward;
        if (rewardTo != address(0) && rewardBps > 0) {
            reward = notional * rewardBps / BPS;
            if (reward > penalty) reward = penalty;
            penalty -= reward;
        }
        uint256 costs = notional * feeBps / BPS + penalty + reward;

        int256 equity = int256(uint256(pos.margin)) + pnl - int256(costs);
        uint256 margin_ = pos.margin;
        bool trader_ = msg.sender == pos.trader;
        address trader = pos.trader;

        _reduceAggregates(m, pos.isLong, pos.baseSize, pos.entryPrice);
        _deletePosition(positionId);

        // conservation made trivial: the whole margin moves to the vault, and the
        // vault pays every sink — trader equity and the executor reward
        if (margin_ > 0) cash.safeTransfer(address(m.vault), margin_);
        if (reward > 0) m.vault.payOut(rewardTo, reward);
        if (equity <= 0) {
            uint256 shortfall = uint256(-equity);
            m.vault.recordShortfall(shortfall);
            emit PositionClosed(positionId, msg.sender, trader_ ? 0 : 2, 0, shortfall);
        } else {
            m.vault.payOut(trader, uint256(equity));
            emit PositionClosed(positionId, msg.sender, trader_ ? 0 : 2, uint256(equity), 0);
        }
    }

    /// @dev Margin died mid-chunk: realize what margin covers, close the rest at
    /// the current price, book the uncovered remainder as LP shortfall.
    function _backstopRemainder(
        bytes32 positionId,
        uint256 p,
        address rewardTo,
        uint256 reward,
        uint256 penalty,
        uint256 chunkLoss,
        uint256 chunk
    ) internal {
        Position storage pos = positions[positionId];
        Market storage m = markets[pos.poolId];
        ERC20 cash = ERC20(Currency.unwrap(m.key.currency1));

        uint256 remLoss = pos.isLong
            ? FullMath.mulDiv(pos.baseSize - chunk, pos.entryPrice > p ? pos.entryPrice - p : 0, WAD)
            : FullMath.mulDiv(pos.baseSize - chunk, p > pos.entryPrice ? p - pos.entryPrice : 0, WAD);
        uint256 totalCharge = chunkLoss + remLoss + penalty + reward;
        uint256 margin_ = pos.margin;
        uint256 shortfall = totalCharge > margin_ ? totalCharge - margin_ : 0;

        _reduceAggregates(m, pos.isLong, pos.baseSize, pos.entryPrice);
        address trader = pos.trader;
        _deletePosition(positionId);

        if (margin_ > 0) cash.safeTransfer(address(m.vault), margin_);
        if (reward > 0 && rewardTo != address(0)) m.vault.payOut(rewardTo, reward);
        if (shortfall > 0) m.vault.recordShortfall(shortfall);
        // trader keeps nothing; hard floor at zero (no negative balances)
        emit PositionClosed(positionId, trader, 2, 0, shortfall);
    }

    function _deletePosition(bytes32 positionId) internal {
        Position storage pos = positions[positionId];
        Market storage m = markets[pos.poolId];
        triggers[pos.poolId].deregister(pos.tickStart, m.key.tickSpacing, positionId);
        triggers[pos.poolId].deregister(pos.tickEnd, m.key.tickSpacing, positionId);
        delete positions[positionId];
    }

    function _reduceAggregates(Market storage m, bool isLong, uint256 base, uint256 entry) internal {
        uint256 cost = FullMath.mulDiv(base, entry, WAD);
        if (isLong) {
            m.baseLong -= uint128(base);
            m.costLong = m.costLong > cost ? m.costLong - cost : 0;
        } else {
            m.baseShort -= uint128(base);
            m.costShort = m.costShort > cost ? m.costShort - cost : 0;
        }
    }

    // ------------------------------------------------------------------ pricing & ranges

    /// cash per 1e18 base at a tick (base = token0)
    function _priceAtTick(int24 tick) internal pure returns (uint256) {
        return LiqRangeMath.convertAtSqrtPrice(WAD, TickMath.getSqrtPriceAtTick(tick), true);
    }

    /// The ADL range from margin arithmetic (not a fixed width): the maintenance
    /// boundary where equity = m·notional, and the bankruptcy boundary where
    /// equity = 0. For a long: P_s = (E − M/B)/(1 − m), P_bk = E − M/B; range is
    /// entered downward. Shorts mirror upward. A position whose margin covers
    /// the whole notional has no liquidation price and is rejected (leverage < 1
    /// belongs in spot, not a perp).
    function _adlRange(bool isLong, uint256 entry, uint256 baseSize, uint256 margin, uint16 mBps, int24 spacing)
        internal
        pure
        returns (int24 tickStart, int24 tickEnd)
    {
        uint256 mPerBase = FullMath.mulDiv(margin, WAD, baseSize); // cash per 1e18 base
        uint256 pStart;
        uint256 pBk;
        if (isLong) {
            if (mPerBase >= entry) revert FullyBackedPosition();
            pBk = entry - mPerBase;
            pStart = FullMath.mulDiv(pBk, BPS, BPS - mBps);
        } else {
            pBk = entry + mPerBase;
            pStart = FullMath.mulDiv(pBk, BPS, BPS + mBps);
        }
        int24 rawStart = TickMath.getTickAtSqrtPrice(_sqrtX96(pStart));
        int24 rawEnd = TickMath.getTickAtSqrtPrice(_sqrtX96(pBk));
        if (isLong) {
            tickStart = _align(rawStart, spacing, true); // trigger earlier: higher
            tickEnd = _align(rawEnd, spacing, false);
        } else {
            tickStart = _align(rawStart, spacing, false); // trigger earlier: lower
            tickEnd = _align(rawEnd, spacing, true);
        }
    }

    /// sqrtPriceX96 for a price expressed as cash (token1) per 1e18 base (token0)
    function _sqrtX96(uint256 p) internal pure returns (uint160) {
        uint256 s = FixedPointMathLib.sqrt(FullMath.mulDiv(p, 1 << 128, WAD)) << 32;
        if (s <= TickMath.MIN_SQRT_PRICE) s = TickMath.MIN_SQRT_PRICE + 1;
        if (s >= TickMath.MAX_SQRT_PRICE) s = TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }

    function _align(int24 tick, int24 spacing, bool up) internal pure returns (int24 aligned) {
        aligned = (tick / spacing) * spacing;
        if (up && aligned < tick) aligned += spacing;
        if (!up && aligned > tick) aligned -= spacing;
        int24 maxUsable = (TickMath.MAX_TICK / spacing) * spacing;
        int24 minUsable = (TickMath.MIN_TICK / spacing) * spacing;
        if (aligned > maxUsable) aligned = maxUsable;
        if (aligned < minUsable) aligned = minUsable;
    }

    function _forceCloseReason(bytes32 positionId) internal view returns (uint8) {
        Position storage pos = positions[positionId];
        if (pos.trader == address(0)) return 0;
        (, int24 tick,,) = poolManager.getSlot0(pos.poolId);
        if (LiqRangeMath.pastRange(pos.isLong, tick, pos.tickEnd)) return 1;

        // equity at the filtered (manipulation-resistant) price, funding included
        Market storage m = markets[pos.poolId];
        uint256 p = _priceAtTick(oracles[pos.poolId].medianTick());
        int256 pnl = pos.isLong
            ? int256(FullMath.mulDiv(pos.baseSize, p, WAD)) - int256(FullMath.mulDiv(pos.baseSize, pos.entryPrice, WAD))
            : int256(FullMath.mulDiv(pos.baseSize, pos.entryPrice, WAD)) - int256(FullMath.mulDiv(pos.baseSize, p, WAD));
        int256 cum = pos.isLong ? m.cumFundingLong : m.cumFundingShort;
        int256 fundingOwed = (cum - pos.fundingSnap) * int256(uint256(pos.baseSize)) / int256(WAD);
        if (int256(uint256(pos.margin)) + pnl - fundingOwed <= 0) return 2;
        return 0;
    }

    function _currentPenaltyBps(Position storage pos, Config memory cfg) internal view returns (uint256) {
        uint256 timeInLiq = pos.timeInLiqAccrued;
        if (pos.liqStartedAt != 0) timeInLiq += block.timestamp - pos.liqStartedAt;
        // LT-analog for the penalty cap: maintenance margin plays the LT-gap role
        return ChunkMath.penaltyBps(cfg.basePenaltyBps, uint16(BPS - cfg.maintenanceMarginBps), timeInLiq, cfg.timeCapX);
    }

    // ------------------------------------------------------------------ views

    /// @notice Net unrealized PnL owed to traders at the filtered price — the
    /// vault's equity feed (PerpVault.equity = cash − this).
    function unrealizedOwed(PoolId poolId) external view returns (int256) {
        Market storage m = markets[poolId];
        if (m.baseLong + m.baseShort == 0) return 0;
        uint256 p = _priceAtTick(oracles[poolId].medianTick());
        int256 uL = int256(FullMath.mulDiv(m.baseLong, p, WAD)) - int256(m.costLong);
        int256 uS = int256(m.costShort) - int256(FullMath.mulDiv(m.baseShort, p, WAD));
        return uL + uS;
    }

    function getPosition(bytes32 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    function getMarket(PoolId poolId)
        external
        view
        returns (PerpVault vault, bool enabled, uint128 baseLong, uint128 baseShort, int256 cumFundingLong)
    {
        Market storage m = markets[poolId];
        return (m.vault, m.enabled, m.baseLong, m.baseShort, m.cumFundingLong);
    }

    function getConfig(PoolId poolId) external view returns (Config memory) {
        return configs[poolId];
    }

    function queueLength(PoolId poolId) external view returns (uint256) {
        return liqQueue[poolId].length;
    }

    // ------------------------------------------------------------------ admin

    function setConfig(PoolId poolId, Config calldata cfg) external onlyOwner {
        if (
            cfg.targetChunks == 0 || cfg.chunkInterval == 0 || cfg.timeCapX == 0 || cfg.maxChunkDepthBps == 0
                || cfg.maintenanceMarginBps == 0 || cfg.maintenanceMarginBps > 2000
                || cfg.initialMarginBps < 2 * cfg.maintenanceMarginBps
        ) revert BadConfig();
        configs[poolId] = cfg;
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x >= 0 ? x : -x);
    }
}
