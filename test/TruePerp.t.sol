// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {TruePerpHook} from "../src/TruePerpHook.sol";
import {PerpVault} from "../src/PerpVault.sol";
import {PerpVaultFactory} from "../src/PerpVaultFactory.sol";

contract TruePerpTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    TruePerpHook hook;
    PerpVaultFactory factory;
    PerpVault vault;
    PoolKey poolKey;
    PoolId poolId;

    MockERC20 base; // token0 — the traded asset
    MockERC20 cash; // token1 — margin + settlement

    address alice = makeAddr("alice"); // long
    address bob = makeAddr("bob"); // short
    address lp = makeAddr("lp");
    address keeper = makeAddr("keeper");
    address whale = makeAddr("whale"); // spot price mover

    function setUp() public {
        deployFreshManagerAndRouters();

        MockERC20 t0 = new MockERC20("Base", "BASE", 18);
        MockERC20 t1 = new MockERC20("Cash", "CASH", 18);
        if (address(t0) > address(t1)) (t0, t1) = (t1, t0);
        (base, cash) = (t0, t1);

        factory = new PerpVaultFactory();
        (address hookAddress, bytes32 hookSalt) = HookMiner.find(
            address(this),
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(TruePerpHook).creationCode,
            abi.encode(address(manager), address(factory), address(this))
        );
        hook = new TruePerpHook{salt: hookSalt}(manager, factory, address(this));
        require(address(hook) == hookAddress, "hook address mismatch");

        poolKey = PoolKey({
            currency0: Currency.wrap(address(base)),
            currency1: Currency.wrap(address(cash)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hookAddress)
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        poolId = poolKey.toId();
        (vault,,,,) = hook.getMarket(poolId);

        // spot liquidity: the price source and ADL depth reference
        base.mint(address(this), 1_000_000e18);
        cash.mint(address(this), 1_000_000e18);
        base.approve(address(modifyLiquidityRouter), type(uint256).max);
        cash.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 100_000e18, salt: 0}),
            ""
        );

        // LP house capital
        cash.mint(lp, 100_000e18);
        vm.startPrank(lp);
        cash.approve(address(vault), type(uint256).max);
        vault.deposit(20_000e18, lp);
        vm.stopPrank();

        // traders + whale
        for (uint256 i = 0; i < 2; i++) {
            address user = [alice, bob][i];
            cash.mint(user, 100_000e18);
            vm.prank(user);
            cash.approve(address(hook), type(uint256).max);
        }
        base.mint(whale, 10_000_000e18);
        cash.mint(whale, 10_000_000e18);
        vm.startPrank(whale);
        base.approve(address(swapRouter), type(uint256).max);
        cash.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        _warmOracle();
    }

    function _warmOracle() internal {
        for (uint256 i = 0; i < 9; i++) {
            skip(61);
            _swap(true, 1e15);
            _swap(false, 1e15);
        }
    }

    function _swap(bool zeroForOne, uint256 amountIn) internal {
        vm.prank(whale);
        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// Exact landing at a target tick, either direction.
    function _swapToTick(int24 target) internal {
        bool down = target < _tick();
        vm.prank(whale);
        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: down,
                amountSpecified: -int256(5_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(poolId);
    }

    /// 5x long: 100 margin, 500 base at ~1:1.
    function _openLong() internal returns (bytes32 id) {
        vm.prank(alice);
        id = hook.openPosition(poolKey, true, 100e18, 500e18);
    }

    // ------------------------------------------------------------------ open

    function test_open_long_placesMarginDerivedRange() public {
        uint256 hookCashBefore = cash.balanceOf(address(hook));
        bytes32 id = _openLong();
        TruePerpHook.Position memory pos = hook.getPosition(id);

        assertEq(pos.trader, alice);
        assertTrue(pos.isLong);
        assertEq(pos.baseSize, 500e18);
        assertApproxEqRel(pos.entryPrice, 1e18, 0.01e18, "entry ~1 (worse-of on a flat book)");
        // open fee 10 bps of 500 notional = 0.5
        assertApproxEqRel(pos.margin, 99.5e18, 0.001e18, "margin net of open fee");
        assertEq(cash.balanceOf(address(hook)) - hookCashBefore, uint256(pos.margin), "hook custodies margin");

        // bankruptcy at E - M/B = 1 - 0.199 = 0.801; maintenance start = pBk/0.98
        // ticks: ln(0.8173)/ln(1.0001) ~ -2017, ln(0.801) ~ -2219
        assertApproxEqAbs(pos.tickStart, -2017, 70, "maintenance boundary");
        assertApproxEqAbs(pos.tickEnd, -2219, 70, "bankruptcy boundary");
        assertEq(pos.liqStartedAt, 0, "not in ADL at open");

        (,, uint128 baseLong,,) = hook.getMarket(poolId);
        assertEq(baseLong, 500e18);
    }

    function test_open_guards() public {
        // initial margin: 500 bps => 20x max; 25x must revert
        vm.prank(alice);
        vm.expectRevert(TruePerpHook.OverLeveraged.selector);
        hook.openPosition(poolKey, true, 20e18, 500e18);

        // fully backed (margin >= notional) is not a perp
        vm.prank(alice);
        vm.expectRevert(TruePerpHook.FullyBackedPosition.selector);
        hook.openPosition(poolKey, true, 600e18, 500e18);

        // OI cap: 50% of ~20k LP equity = ~10k notional
        vm.prank(alice);
        vm.expectRevert(TruePerpHook.OpenInterestCapExceeded.selector);
        hook.openPosition(poolKey, true, 5_000e18, 20_000e18);
    }

    // ------------------------------------------------------------------ chunked ADL

    function test_adl_decaysInRange_pausesOnRecovery() public {
        bytes32 id = _openLong();
        TruePerpHook.Position memory pos = hook.getPosition(id);

        _swapToTick(pos.tickStart - 60); // just inside the range
        assertGt(hook.getPosition(id).liqStartedAt, 0, "ADL episode started");

        uint256 vaultBefore = vault.cash();
        skip(61);
        vm.prank(keeper);
        hook.poke(poolKey);

        TruePerpHook.Position memory p2 = hook.getPosition(id);
        assertLt(p2.baseSize, 500e18, "notional reduced by a chunk");
        assertLt(p2.margin, pos.margin, "loss + penalty realized against margin");
        assertGt(vault.cash(), vaultBefore, "LP vault absorbed the realized loss + penalty");
        assertGt(cash.balanceOf(keeper), 0, "poker rewarded from the penalty flow");

        // recovery: price back above the range start pauses the process
        _swapToTick(pos.tickStart + 120);
        assertEq(hook.getPosition(id).liqStartedAt, 0, "ADL paused");
        uint128 sizeAfterPause = hook.getPosition(id).baseSize;
        skip(61);
        vm.prank(keeper);
        hook.poke(poolKey);
        assertEq(hook.getPosition(id).baseSize, sizeAfterPause, "no decay while out of range");
    }

    /// Deleveraging is self-terminating: every chunk shrinks the notional faster
    /// than it burns margin, so equity eventually covers maintenance on what is
    /// left and ADL pauses — the perp analog of a loan's decay ending at debt = 0.
    /// The trader keeps a smaller, healthy position; nothing is ground to dust.
    function test_adl_decaysUntilHealthy_thenStops() public {
        bytes32 id = _openLong();
        TruePerpHook.Position memory pos = hook.getPosition(id);
        _swapToTick(pos.tickStart - 60);

        bool healthy;
        for (uint256 i = 0; i < 400; i++) {
            skip(61);
            vm.prank(keeper);
            hook.poke(poolKey);
            TruePerpHook.Position memory p = hook.getPosition(id);
            if (p.liqStartedAt == 0) {
                healthy = true;
                break;
            }
        }
        assertTrue(healthy, "ADL stopped once maintenance was restored");
        TruePerpHook.Position memory p2 = hook.getPosition(id);
        assertGt(p2.baseSize, 0, "position survives, deleveraged");
        assertLt(p2.baseSize, 500e18, "materially reduced");
        assertGt(p2.margin, 0);
        assertEq(hook.forceCloseReason(id), 0, "healthy at the filtered price");

        // and it stays paused while the price holds
        uint128 size = p2.baseSize;
        skip(61);
        vm.prank(keeper);
        hook.poke(poolKey);
        assertEq(hook.getPosition(id).baseSize, size, "no further decay while healthy");
    }

    // ------------------------------------------------------------------ backstop

    function test_backstop_pastBankruptcy_shortfallToLPs() public {
        bytes32 id = _openLong();
        TruePerpHook.Position memory pos = hook.getPosition(id);

        _swapToTick(pos.tickEnd - 200); // gap straight past bankruptcy
        assertEq(hook.forceCloseReason(id), 1, "bankruptcy boundary crossed");

        uint256 keeperBefore = cash.balanceOf(keeper);
        vm.prank(keeper);
        hook.forceClose(id);

        assertEq(hook.getPosition(id).trader, address(0), "closed");
        assertGt(cash.balanceOf(keeper), keeperBefore, "backstop caller rewarded");
        assertGt(vault.totalShortfall(), 0, "uncovered loss recorded for LPs");
        assertEq(cash.balanceOf(address(hook)), 0, "no stranded margin in the hook");
    }

    function test_backstop_notEligibleWhenHealthy() public {
        bytes32 id = _openLong();
        vm.prank(keeper);
        vm.expectRevert(TruePerpHook.NotEligibleForForceClose.selector);
        hook.forceClose(id);
    }

    // ------------------------------------------------------------------ trader close & PnL

    function test_close_profitableLong_paidByVault() public {
        vm.prank(alice);
        bytes32 id = hook.openPosition(poolKey, true, 250e18, 500e18); // 2x

        // sustained +4% move; the worse-of exit needs the FILTER to catch up,
        // which is exactly the manipulation resistance working as designed
        _swapToTick(392); // ~ +4%
        for (uint256 i = 0; i < 9; i++) {
            skip(61);
            _swap(true, 1e15);
            _swap(false, 1e15);
        }

        uint256 aliceBefore = cash.balanceOf(alice);
        uint256 vaultBefore = vault.cash();
        vm.prank(alice);
        hook.closePosition(id);

        uint256 payout = cash.balanceOf(alice) - aliceBefore;
        // equity = margin + ~4%*500 - fees ~ 250 + 20 - 1 (entry was slightly
        // above 1 from the worse-of, exit slightly below the peak)
        assertGt(payout, 258e18, "profit realized");
        assertLt(payout, 275e18, "bounded by the actual move");
        assertLt(vault.cash(), vaultBefore + 250e18, "win net of margin came from LPs");
        assertEq(cash.balanceOf(address(hook)), 0, "margin ledger fully unwound");
    }

    function test_close_losingShort_lossStaysWithLPs() public {
        vm.prank(bob);
        bytes32 id = hook.openPosition(poolKey, false, 250e18, 500e18); // 2x short

        _swapToTick(392); // price up 4%: bad for the short
        for (uint256 i = 0; i < 9; i++) {
            skip(61);
            _swap(true, 1e15);
            _swap(false, 1e15);
        }

        uint256 bobBefore = cash.balanceOf(bob);
        uint256 vaultBefore = vault.cash();
        vm.prank(bob);
        hook.closePosition(id);

        uint256 payout = cash.balanceOf(bob) - bobBefore;
        assertLt(payout, 235e18, "loss deducted");
        assertGt(payout, 215e18, "but only the actual move + fees");
        assertGt(vault.cash(), vaultBefore, "LPs keep the counterparty gain");
    }

    // ------------------------------------------------------------------ funding

    function test_funding_skewChargesLongsCreditsShorts() public {
        bytes32 idL = _openLong(); // 500 long
        vm.prank(bob);
        bytes32 idS = hook.openPosition(poolKey, false, 100e18, 100e18); // 100 short: skew +2/3

        uint256 hookBefore = cash.balanceOf(address(hook));
        uint256 vaultBefore = vault.cash();
        skip(1 days);
        vm.prank(keeper);
        hook.poke(poolKey); // touches funding accrual

        (,,,, int256 cumLong) = hook.getMarket(poolId);
        assertGt(cumLong, 0, "longs pay under positive skew");
        assertGt(vault.cash(), vaultBefore, "imbalance residual accrues to LPs");
        assertLt(cash.balanceOf(address(hook)), hookBefore, "residual left trader margin pool");

        // the short banks the funding credit at close
        uint256 bobBefore = cash.balanceOf(bob);
        vm.prank(bob);
        hook.closePosition(idS);
        uint256 payout = cash.balanceOf(bob) - bobBefore;
        assertGt(payout, 99.5e18, "funding credit beats the close fee");

        // the long pays it on its next settlement
        uint256 aliceBefore = cash.balanceOf(alice);
        vm.prank(alice);
        hook.closePosition(idL);
        assertLt(cash.balanceOf(alice) - aliceBefore, 99.5e18, "funding charge on the long");
    }

    // ------------------------------------------------------------------ LP accounting

    function test_lp_equityTracksTraderPnl() public {
        assertEq(vault.equity(), vault.cash(), "no OI: equity == cash");
        vm.prank(alice);
        hook.openPosition(poolKey, true, 250e18, 500e18);

        // price up: the long's unrealized win is an LP liability
        _swapToTick(392);
        for (uint256 i = 0; i < 9; i++) {
            skip(61);
            _swap(true, 1e15);
            _swap(false, 1e15);
        }
        assertGt(hook.unrealizedOwed(poolId), 0);
        assertLt(vault.equity(), vault.cash(), "unrealized trader win priced into LP equity");

        // deposit/redeem stay consistent with equity
        vm.startPrank(lp);
        uint256 shares = vault.deposit(1_000e18, lp);
        uint256 backOut = vault.redeem(shares, lp);
        vm.stopPrank();
        assertApproxEqRel(backOut, 1_000e18, 0.001e18, "round trip at equity price");
    }
}
