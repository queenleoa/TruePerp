// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

import {TruePerpHook} from "../src/TruePerpHook.sol";

/// @notice Add one time-spaced observation to the demo market's nine-point
/// oracle by making a tiny swap that steers price back toward the launch price.
/// Run this script eight times, waiting at least 60 seconds between confirmed
/// transactions. The hook itself ignores observations that arrive too soon.
contract WarmOracle is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant DEFAULT_POOL_MANAGER = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
    address internal constant DEFAULT_POOL_SWAP_TEST = 0x9140a78c1A137c7fF1c151EC8231272aF78a99A4;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_ETH_IS_0 = 3_543_191_142_285_914_205_922_034;
    uint160 internal constant SQRT_PRICE_USDC_IS_0 = 1_771_595_571_142_957_102_961_017_161_607_260;

    error WalletMismatch();
    error MissingDeployment(address target);
    error WrongPool();

    function run() external {
        uint256 deployerKey = vm.envUint("WALLET_PRIVATE_KEY");
        address owner = vm.envAddress("WALLET_ADDRESS");
        if (vm.addr(deployerKey) != owner) revert WalletMismatch();

        IPoolManager poolManager = IPoolManager(vm.envOr("POOL_MANAGER", DEFAULT_POOL_MANAGER));
        PoolSwapTest swapRouter = PoolSwapTest(vm.envOr("POOL_SWAP_TEST", DEFAULT_POOL_SWAP_TEST));
        ERC20 trueEth = ERC20(vm.envAddress("TRUE_ETH"));
        ERC20 trueUsdc = ERC20(vm.envAddress("TRUE_USDC"));
        TruePerpHook hook = TruePerpHook(payable(vm.envAddress("TRUEPERP_HOOK")));

        _requireCode(address(poolManager));
        _requireCode(address(swapRouter));
        _requireCode(address(trueEth));
        _requireCode(address(trueUsdc));
        _requireCode(address(hook));
        if (address(hook.poolManager()) != address(poolManager)) revert WrongPool();

        bool baseIs0 = address(trueEth) < address(trueUsdc);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(baseIs0 ? address(trueEth) : address(trueUsdc)),
            currency1: Currency.wrap(baseIs0 ? address(trueUsdc) : address(trueEth)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        PoolId poolId = key.toId();
        (,,, bool enabled) = hook.getPool(poolId);
        if (!enabled) revert WrongPool();

        (, int24 tickBefore,,) = poolManager.getSlot0(poolId);
        int24 launchTick = TickMath.getTickAtSqrtPrice(baseIs0 ? SQRT_PRICE_ETH_IS_0 : SQRT_PRICE_USDC_IS_0);
        bool zeroForOne = tickBefore >= launchTick;
        address inputToken = Currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
        uint256 amountIn = inputToken == address(trueEth) ? 0.001 ether : 2e6;

        vm.startBroadcast(deployerKey);
        ERC20(inputToken).approve(address(swapRouter), amountIn);
        BalanceDelta delta = swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopBroadcast();

        (, int24 tickAfter,,) = poolManager.getSlot0(poolId);
        console.log("Oracle warm-up swap confirmed by simulation");
        console.log("Block timestamp:", block.timestamp);
        console.log("Input token:", inputToken);
        console.log("Input raw amount:", amountIn);
        console.log("Tick before:");
        console.logInt(tickBefore);
        console.log("Tick after:");
        console.logInt(tickAfter);
        console.log("Packed balance delta:");
        console.logInt(BalanceDelta.unwrap(delta));
        console.log("Wait >=60 seconds before the next run; eight spaced runs are required after deployment.");
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingDeployment(target);
    }
}
