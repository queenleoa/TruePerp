// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {TrueLendHook} from "truelend/TrueLendHook.sol";
import {LendingVault} from "truelend/LendingVault.sol";
import {PerpLendingVaultFactory} from "../src/PerpLendingVaultFactory.sol";
import {TruePerpHook} from "../src/TruePerpHook.sol";
import {TruePerpRouter} from "../src/TruePerpRouter.sol";

contract TruePerpTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant MARGIN = 100e18;
    uint256 internal constant BORROW = 390e18;
    uint16 internal constant LT_BPS = 9500;

    TruePerpHook hook;
    TruePerpRouter router;
    PerpLendingVaultFactory factory;
    WETH weth;

    PoolKey poolKey;
    PoolId poolId;
    LendingVault baseVault;
    LendingVault quoteVault;

    MockERC20 base; // BASE is currency0 in the primary fixture
    MockERC20 quote; // all trader margin is denominated in QUOTE

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address lender = makeAddr("lender");
    address keeper = makeAddr("keeper");
    address whale = makeAddr("whale");

    function setUp() public {
        deployFreshManagerAndRouters();

        MockERC20 tokenA = new MockERC20("Base", "BASE", 18);
        MockERC20 tokenB = new MockERC20("Quote", "QUOTE", 18);
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);
        base = tokenA;
        quote = tokenB;

        factory = new PerpLendingVaultFactory();
        weth = new WETH();
        (address hookAddress, bytes32 hookSalt) = HookMiner.find(
            address(this),
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(TruePerpHook).creationCode,
            abi.encode(address(manager), address(factory), address(this), address(weth))
        );
        hook = new TruePerpHook{salt: hookSalt}(manager, address(factory), address(this), address(weth));
        require(address(hook) == hookAddress, "hook address mismatch");
        router = new TruePerpRouter(manager, hook, address(this));

        poolKey = PoolKey({
            currency0: Currency.wrap(address(base)),
            currency1: Currency.wrap(address(quote)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hookAddress)
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        poolId = poolKey.toId();
        (baseVault, quoteVault,,) = hook.getPool(poolId);

        // The inherited compact position layout stores a uint32 term. Its
        // maximum value is TruePerp's explicit no-scheduled-expiry sentinel.
        hook.configurePerpetual(poolId);
        router.activateMarket(poolKey, poolKey.currency0);

        base.mint(address(this), 1_000_000e18);
        quote.mint(address(this), 1_000_000e18);
        base.approve(address(modifyLiquidityRouter), type(uint256).max);
        quote.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 100_000e18, salt: 0}),
            ""
        );

        // The vaults are deliberately supporting infrastructure: one supplies
        // BASE debt for shorts, the other QUOTE debt for longs.
        base.mint(lender, 20_000e18);
        quote.mint(lender, 20_000e18);
        vm.startPrank(lender);
        base.approve(address(baseVault), type(uint256).max);
        quote.approve(address(quoteVault), type(uint256).max);
        baseVault.deposit(20_000e18, lender);
        quoteVault.deposit(20_000e18, lender);
        vm.stopPrank();

        for (uint256 i = 0; i < 2; i++) {
            address trader = i == 0 ? alice : bob;
            base.mint(trader, 100_000e18);
            quote.mint(trader, 100_000e18);
            vm.startPrank(trader);
            base.approve(address(router), type(uint256).max);
            quote.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }

        base.mint(whale, 10_000_000e18);
        quote.mint(whale, 10_000_000e18);
        vm.startPrank(whale);
        base.approve(address(swapRouter), type(uint256).max);
        quote.approve(address(swapRouter), type(uint256).max);
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

    function _swapToTick(int24 target) internal {
        bool zeroForOne = target < _tick();
        vm.prank(whale);
        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(1_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(poolId);
    }

    function _sqrtRatioX96(uint256 amount1, uint256 amount0) internal pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(amount1, uint256(1) << 192, amount0);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function _open(address trader, bool isLong) internal returns (bytes32 id) {
        vm.prank(trader);
        id = router.openPosition(
            TruePerpRouter.OpenParams({
                key: poolKey,
                isLong: isLong,
                margin: MARGIN,
                borrowAmount: BORROW,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 370e18,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
    }

    // ---------------------------------------------------------------- market setup

    function test_marketIsExplicitlyPerpetualAndOriented() public view {
        (bool active, bool baseIs0) = router.getMarket(poolId);
        assertTrue(active);
        assertTrue(baseIs0);
        assertEq(hook.getConfig(poolId).termSeconds, type(uint32).max);
        assertEq(baseVault.baseRateBps(), 0);
        assertEq(baseVault.slope1Bps(), 0);
        assertEq(baseVault.slope2Bps(), 0);
        assertEq(baseVault.rateCeilingBps(), 0);
        assertEq(baseVault.reserveFactorBps(), 0);
        assertEq(baseVault.utilCapBps(), 9000);
        assertEq(quoteVault.rateBps(10_000), 0);
        assertLe(address(hook).code.length, 24_576, "hook must remain deployable under EIP-170");
    }

    function test_marketCanOrientBaseAsCurrency1() public {
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        if (address(a) > address(b)) (a, b) = (b, a);
        PoolKey memory reverseKey = PoolKey({
            currency0: Currency.wrap(address(a)),
            currency1: Currency.wrap(address(b)),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });
        manager.initialize(reverseKey, SQRT_PRICE_1_1);
        PoolId reverseId = reverseKey.toId();
        hook.configurePerpetual(reverseId);
        router.activateMarket(reverseKey, reverseKey.currency1);

        (bool active, bool baseIs0) = router.getMarket(reverseId);
        assertTrue(active);
        assertFalse(baseIs0);

        a.mint(address(this), 1_000_000e18);
        b.mint(address(this), 1_000_000e18);
        a.approve(address(modifyLiquidityRouter), type(uint256).max);
        b.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            reverseKey,
            ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 100_000e18, salt: 0}),
            ""
        );

        (LendingVault reverseQuoteVault, LendingVault reverseBaseVault,,) = hook.getPool(reverseId);
        a.approve(address(reverseQuoteVault), type(uint256).max);
        b.approve(address(reverseBaseVault), type(uint256).max);
        reverseQuoteVault.deposit(20_000e18, address(this));
        reverseBaseVault.deposit(20_000e18, address(this));

        a.mint(alice, 10_000e18);
        vm.startPrank(alice);
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        vm.stopPrank();

        a.mint(whale, 1_000_000e18);
        b.mint(whale, 1_000_000e18);
        vm.startPrank(whale);
        a.approve(address(swapRouter), type(uint256).max);
        b.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        for (uint256 i = 0; i < 9; i++) {
            skip(61);
            vm.prank(whale);
            swapRouter.swap(
                reverseKey,
                SwapParams({
                    zeroForOne: true, amountSpecified: -int256(1e15), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
            vm.prank(whale);
            swapRouter.swap(
                reverseKey,
                SwapParams({
                    zeroForOne: false, amountSpecified: -int256(1e15), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        }

        vm.startPrank(alice);
        bytes32 longId = router.openPosition(
            TruePerpRouter.OpenParams({
                key: reverseKey,
                isLong: true,
                margin: MARGIN,
                borrowAmount: BORROW,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 370e18,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
        TrueLendHook.Position memory position = hook.getPosition(longId);
        assertFalse(position.collateralIs0, "BASE long collateral is currency1");
        assertApproxEqAbs(hook.debtOf(longId), BORROW, 1);
        router.closePosition(
            TruePerpRouter.CloseParams({
                key: reverseKey,
                positionId: longId,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );

        bytes32 shortId = router.openPosition(
            TruePerpRouter.OpenParams({
                key: reverseKey,
                isLong: false,
                margin: MARGIN,
                borrowAmount: BORROW,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 370e18,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
        position = hook.getPosition(shortId);
        assertTrue(position.collateralIs0, "QUOTE short collateral is currency0");
        assertApproxEqAbs(hook.debtOf(shortId), BORROW, 1);
        router.closePosition(
            TruePerpRouter.CloseParams({
                key: reverseKey,
                positionId: shortId,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(reverseQuoteVault.totalBorrowShares(), 0);
        assertEq(reverseBaseVault.totalBorrowShares(), 0);
        assertEq(a.balanceOf(address(router)), 0);
        assertEq(b.balanceOf(address(router)), 0);
    }

    function test_realisticWethUsdcDecimalsOpenAndClose() public {
        MockERC20 weth18 = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 usdc6 = new MockERC20("USD Coin", "USDC", 6);
        bool baseIs0 = address(weth18) < address(usdc6);
        Currency currency0 = Currency.wrap(baseIs0 ? address(weth18) : address(usdc6));
        Currency currency1 = Currency.wrap(baseIs0 ? address(usdc6) : address(weth18));
        PoolKey memory realisticKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        uint160 sqrtPriceX96 = baseIs0 ? _sqrtRatioX96(2000e6, 1e18) : _sqrtRatioX96(1e18, 2000e6);
        manager.initialize(realisticKey, sqrtPriceX96);
        PoolId realisticId = realisticKey.toId();
        hook.configurePerpetual(realisticId);
        router.activateMarket(realisticKey, Currency.wrap(address(weth18)));

        weth18.mint(address(this), 1e30);
        usdc6.mint(address(this), 1e30);
        weth18.approve(address(modifyLiquidityRouter), type(uint256).max);
        usdc6.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            realisticKey,
            ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e22, salt: 0}),
            ""
        );

        (LendingVault vault0, LendingVault vault1,,) = hook.getPool(realisticId);
        LendingVault realisticBaseVault = baseIs0 ? vault0 : vault1;
        LendingVault realisticQuoteVault = baseIs0 ? vault1 : vault0;
        weth18.approve(address(realisticBaseVault), type(uint256).max);
        usdc6.approve(address(realisticQuoteVault), type(uint256).max);
        realisticBaseVault.deposit(1000e18, address(this));
        realisticQuoteVault.deposit(2_000_000e6, address(this));

        uint256 dustBase = 1e12;
        uint256 dustQuote = 1000;
        weth18.approve(address(swapRouter), type(uint256).max);
        usdc6.approve(address(swapRouter), type(uint256).max);
        for (uint256 i = 0; i < 9; i++) {
            skip(61);
            swapRouter.swap(
                realisticKey,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(baseIs0 ? dustBase : dustQuote),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
            swapRouter.swap(
                realisticKey,
                SwapParams({
                    zeroForOne: false,
                    amountSpecified: -int256(baseIs0 ? dustQuote : dustBase),
                    sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        }

        address charlie = makeAddr("charlie");
        usdc6.mint(charlie, 10_000e6);
        vm.startPrank(charlie);
        usdc6.approve(address(router), type(uint256).max);
        weth18.approve(address(router), type(uint256).max);
        bytes32 id = router.openPosition(
            TruePerpRouter.OpenParams({
                key: realisticKey,
                isLong: true,
                margin: 1000e6,
                borrowAmount: 3900e6,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 2e18,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
        TrueLendHook.Position memory position = hook.getPosition(id);
        assertEq(position.collateralIs0, baseIs0);
        assertGt(position.collateral, 2e18, "roughly 2.45 WETH held at $2,000");
        assertLt(position.collateral, 3e18);
        assertApproxEqAbs(hook.debtOf(id), 3900e6, 1, "USDC debt keeps six-decimal units");

        router.closePosition(
            TruePerpRouter.CloseParams({
                key: realisticKey,
                positionId: id,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );

        bytes32 shortId = router.openPosition(
            TruePerpRouter.OpenParams({
                key: realisticKey,
                isLong: false,
                margin: 1000e6,
                borrowAmount: 2e18,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 3500e6,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
        position = hook.getPosition(shortId);
        assertEq(position.collateralIs0, !baseIs0);
        assertGt(position.collateral, 4500e6, "USDC collateral includes sale proceeds and margin");
        assertLt(position.collateral, 5100e6);
        assertApproxEqAbs(hook.debtOf(shortId), 2e18, 1, "WETH debt keeps eighteen-decimal units");

        router.closePosition(
            TruePerpRouter.CloseParams({
                key: realisticKey,
                positionId: shortId,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(hook.getPosition(id).borrower, address(0));
        assertEq(hook.getPosition(shortId).borrower, address(0));
        assertEq(realisticQuoteVault.totalBorrowShares(), 0);
        assertEq(realisticBaseVault.totalBorrowShares(), 0);
        assertEq(weth18.balanceOf(address(router)), 0);
        assertEq(usdc6.balanceOf(address(router)), 0);
    }

    function test_openRejectsFiniteTermConfiguration() public {
        TrueLendHook.Config memory config = hook.getConfig(poolId);
        config.termSeconds = 180 days;
        hook.setConfig(poolId, config);

        vm.prank(alice);
        vm.expectRevert(TruePerpRouter.PerpetualHorizonNotConfigured.selector);
        router.openPosition(
            TruePerpRouter.OpenParams({
                key: poolKey,
                isLong: true,
                margin: MARGIN,
                borrowAmount: BORROW,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 1,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
    }

    // ---------------------------------------------------------------- physical positions

    function test_openLongHoldsBaseAndOwesQuote() public {
        uint256 aliceQuoteBefore = quote.balanceOf(alice);
        uint256 quoteVaultCashBefore = quoteVault.cash();
        bytes32 id = _open(alice, true);

        TrueLendHook.Position memory position = hook.getPosition(id);
        assertEq(position.borrower, alice);
        assertTrue(position.collateralIs0, "long collateral is BASE");
        assertGt(position.collateral, 470e18);
        assertLt(position.collateral, 500e18);
        assertEq(base.balanceOf(address(hook)), position.collateral, "hook holds real BASE");
        assertApproxEqAbs(hook.debtOf(id), BORROW, 1, "position owes QUOTE vault");
        assertEq(quoteVaultCashBefore - quoteVault.cash(), BORROW);
        assertEq(baseVault.totalBorrowShares(), 0, "BASE vault uninvolved in a long");
        assertEq(aliceQuoteBefore - quote.balanceOf(alice), MARGIN, "trader posts only quote margin");
        assertGt(position.expiry, block.timestamp + 100 * 365 days, "no practical scheduled expiry");
        assertEq(base.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_openShortHoldsQuoteAndOwesBase() public {
        uint256 bobQuoteBefore = quote.balanceOf(bob);
        uint256 baseVaultCashBefore = baseVault.cash();
        bytes32 id = _open(bob, false);

        TrueLendHook.Position memory position = hook.getPosition(id);
        assertEq(position.borrower, bob);
        assertFalse(position.collateralIs0, "short collateral is QUOTE");
        assertGt(position.collateral, 470e18);
        assertLt(position.collateral, 500e18);
        assertEq(quote.balanceOf(address(hook)), position.collateral, "hook holds real QUOTE");
        assertApproxEqAbs(hook.debtOf(id), BORROW, 1, "position owes BASE vault");
        assertEq(baseVaultCashBefore - baseVault.cash(), BORROW);
        assertEq(quoteVault.totalBorrowShares(), 0, "QUOTE vault uninvolved in a short");
        assertEq(bobQuoteBefore - quote.balanceOf(bob), MARGIN);
        assertEq(base.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_demoDebtStaysConstantSoFixedTriggersRemainValid() public {
        bytes32 longId = _open(alice, true);
        bytes32 shortId = _open(bob, false);
        uint256 longDebtBefore = hook.debtOf(longId);
        uint256 shortDebtBefore = hook.debtOf(shortId);

        skip(10 * 365 days);

        assertEq(hook.debtOf(longId), longDebtBefore, "long trigger geometry does not drift with time");
        assertEq(hook.debtOf(shortId), shortDebtBefore, "short trigger geometry does not drift with time");
        assertEq(hook.forceCloseReason(longId), 0, "time alone does not create a coverage breach");
        assertEq(hook.forceCloseReason(shortId), 0, "time alone does not create a coverage breach");
    }

    // ---------------------------------------------------------------- atomic close

    function test_closeLongRepaysQuoteDebtAndReturnsResidualBase() public {
        bytes32 id = _open(alice, true);
        TrueLendHook.Position memory position = hook.getPosition(id);
        uint256 aliceBaseBefore = base.balanceOf(alice);

        vm.prank(alice);
        router.closePosition(
            TruePerpRouter.CloseParams({
                key: poolKey,
                positionId: id,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );

        assertEq(hook.getPosition(id).borrower, address(0));
        assertEq(quoteVault.totalBorrowShares(), 0, "QUOTE debt fully repaid");
        uint256 residualBase = base.balanceOf(alice) - aliceBaseBefore;
        assertGt(residualBase, MARGIN * 90 / 100, "physical equity returned in BASE");
        assertLt(residualBase, MARGIN, "round-trip fees paid");
        assertEq(base.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_closeShortRepaysBaseDebtAndReturnsResidualQuote() public {
        bytes32 id = _open(bob, false);
        TrueLendHook.Position memory position = hook.getPosition(id);
        uint256 bobQuoteBefore = quote.balanceOf(bob);

        vm.prank(bob);
        router.closePosition(
            TruePerpRouter.CloseParams({
                key: poolKey,
                positionId: id,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );

        assertEq(hook.getPosition(id).borrower, address(0));
        assertEq(baseVault.totalBorrowShares(), 0, "BASE debt fully repaid");
        uint256 residualQuote = quote.balanceOf(bob) - bobQuoteBefore;
        assertGt(residualQuote, MARGIN * 90 / 100, "short equity remains in QUOTE");
        assertLt(residualQuote, MARGIN);
        assertEq(base.balanceOf(address(router)), 0);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    // ---------------------------------------------------------------- keeperless gradual liquidation

    function test_ordinarySwapExecutesRealChunkAndDonatesPenalty() public {
        bytes32 id = _open(alice, true);
        TrueLendHook.Position memory beforePosition = hook.getPosition(id);
        uint256 debtBefore = hook.debtOf(id);

        vm.recordLogs();
        _swapToTick(beforePosition.tickStart - 60);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        TrueLendHook.Position memory afterPosition = hook.getPosition(id);
        assertGt(afterPosition.liqStartedAt, 0, "range crossing starts liquidation");
        assertLt(afterPosition.collateral, beforePosition.collateral, "hook sold physical BASE");
        assertLt(hook.debtOf(id), debtBefore, "QUOTE proceeds repaid vault debt");

        bytes32 donateTopic = keccak256("Donate(bytes32,address,uint256,uint256)");
        bool donatedQuote;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(manager) && logs[i].topics.length == 3 && logs[i].topics[0] == donateTopic
                    && address(uint160(uint256(logs[i].topics[2]))) == address(hook)
            ) {
                (uint256 amount0, uint256 amount1) = abi.decode(logs[i].data, (uint256, uint256));
                if (amount0 == 0 && amount1 > 0) donatedQuote = true;
            }
        }
        assertTrue(donatedQuote, "liquidation penalty donated to active Uniswap LPs");
    }

    function test_shortLiquidationBuysBaseAndRepaysBaseVault() public {
        bytes32 id = _open(bob, false);
        TrueLendHook.Position memory beforePosition = hook.getPosition(id);
        uint256 debtBefore = hook.debtOf(id);

        _swapToTick(beforePosition.tickStart + 60);

        TrueLendHook.Position memory afterPosition = hook.getPosition(id);
        assertGt(afterPosition.liqStartedAt, 0, "rising BASE price starts short liquidation");
        assertLt(afterPosition.collateral, beforePosition.collateral, "hook spent physical QUOTE");
        assertLt(hook.debtOf(id), debtBefore, "purchased BASE repaid the BASE vault");
    }

    function test_pokeAdvancesQuietMarketAndRecoveryPauses() public {
        bytes32 id = _open(alice, true);
        TrueLendHook.Position memory opened = hook.getPosition(id);
        _swapToTick(opened.tickStart - 60);

        uint128 collateralBeforePoke = hook.getPosition(id).collateral;
        uint256 keeperQuoteBefore = quote.balanceOf(keeper);
        skip(61);
        vm.prank(keeper);
        hook.poke(poolKey);

        assertLt(hook.getPosition(id).collateral, collateralBeforePoke, "poke executes one due chunk");
        assertGt(quote.balanceOf(keeper), keeperQuoteBefore, "caller receives carved-out penalty reward");

        _swapToTick(opened.tickStart + 240);
        assertEq(hook.getPosition(id).liqStartedAt, 0, "recovery pauses future chunks");
        uint128 collateralAtPause = hook.getPosition(id).collateral;
        skip(61);
        vm.prank(keeper);
        hook.poke(poolKey);
        assertEq(hook.getPosition(id).collateral, collateralAtPause, "no selling outside the range");
    }

    function test_gapPastRangeUsesSlippageBoundedBackstopAndLossWaterfall() public {
        bytes32 id = _open(alice, true);
        TrueLendHook.Position memory opened = hook.getPosition(id);
        _swapToTick(opened.tickEnd - 60);
        assertEq(hook.forceCloseReason(id), 1, "far edge makes terminal close eligible");

        uint256 keeperQuoteBefore = quote.balanceOf(keeper);
        vm.prank(keeper);
        hook.forceClose(id);

        assertEq(hook.getPosition(id).borrower, address(0), "position exhausted and closed");
        assertEq(quoteVault.totalBorrowShares(), 0, "debt shares retired or written off");
        assertGt(quoteVault.totalUncoveredShortfall(), 0, "residual loss isolated to QUOTE lenders");
        assertGt(quote.balanceOf(keeper), keeperQuoteBefore, "backstop caller receives penalty carve-out");
    }

    // ---------------------------------------------------------------- user guards

    function test_openSlippageAndDeadlineGuards() public {
        vm.prank(alice);
        vm.expectRevert(TruePerpRouter.TooLittleSwapOutput.selector);
        router.openPosition(
            TruePerpRouter.OpenParams({
                key: poolKey,
                isLong: true,
                margin: MARGIN,
                borrowAmount: BORROW,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 500e18,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );

        vm.prank(alice);
        vm.expectRevert(TruePerpRouter.DeadlineExpired.selector);
        router.openPosition(
            TruePerpRouter.OpenParams({
                key: poolKey,
                isLong: true,
                margin: MARGIN,
                borrowAmount: BORROW,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 0,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp - 1
            })
        );

        vm.prank(alice);
        vm.expectRevert(TruePerpRouter.MissingSlippageProtection.selector);
        router.openPosition(
            TruePerpRouter.OpenParams({
                key: poolKey,
                isLong: true,
                margin: MARGIN,
                borrowAmount: BORROW,
                liquidationThresholdBps: LT_BPS,
                minSwapOutput: 0,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
    }

    function test_onlyTraderCanClose() public {
        bytes32 id = _open(alice, true);
        TrueLendHook.Position memory position = hook.getPosition(id);

        vm.prank(bob);
        vm.expectRevert(TruePerpRouter.NotPositionOwner.selector);
        router.closePosition(
            TruePerpRouter.CloseParams({
                key: poolKey,
                positionId: id,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
    }

    function test_closeRejectsWrongPoolKey() public {
        bytes32 id = _open(alice, true);
        TrueLendHook.Position memory position = hook.getPosition(id);
        PoolKey memory wrongKey = PoolKey({
            currency0: poolKey.currency0, currency1: poolKey.currency1, fee: 500, tickSpacing: 10, hooks: poolKey.hooks
        });

        vm.prank(alice);
        vm.expectRevert(TruePerpRouter.WrongPool.selector);
        router.closePosition(
            TruePerpRouter.CloseParams({
                key: wrongKey,
                positionId: id,
                maxCollateralIn: position.collateral,
                sqrtPriceLimitX96: 0,
                deadline: block.timestamp
            })
        );
    }
}
