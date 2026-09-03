// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {TrueLendHook} from "truelend/TrueLendHook.sol";
import {LendingVault} from "truelend/LendingVault.sol";
import {TruePerpHook} from "../src/TruePerpHook.sol";
import {TruePerpRouter} from "../src/TruePerpRouter.sol";
import {PerpLendingVaultFactory} from "../src/PerpLendingVaultFactory.sol";
import {TrueETH, TrueUSDC} from "../src/mocks/TrueDemoTokens.sol";

interface IPositionManagerWiring {
    function permit2() external view returns (IAllowanceTransfer);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Deploy and capitalize the complete TrueETH/TrueUSDC demo market on
/// Unichain Sepolia. Pool liquidity is represented by a standard Uniswap v4
/// PositionManager NFT; the two debt vault deposits are separate capital.
///
/// Run with:
/// forge script script/Deploy.s.sol:Deploy --rpc-url $UNICHAIN_RPC_URL \
///   --always-use-create-2-factory --broadcast --slow
contract Deploy is Script {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant UNICHAIN_SEPOLIA_CHAIN_ID = 1301;
    address internal constant DEFAULT_POOL_MANAGER = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
    address internal constant DEFAULT_POSITION_MANAGER = 0xf969Aee60879C54bAAed9F3eD26147Db216Fd664;
    address internal constant DEFAULT_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant CANONICAL_WETH = 0x4200000000000000000000000000000000000006;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    // Decimal-adjusted Q64.96 square-root prices for 1 tETH = 2,000 tUSDC.
    uint160 internal constant SQRT_PRICE_ETH_IS_0 = 3_543_191_142_285_914_205_922_034;
    uint160 internal constant SQRT_PRICE_USDC_IS_0 = 1_771_595_571_142_957_102_961_017_161_607_260;

    uint256 internal constant LP_TRUE_ETH = 1_000 ether;
    uint256 internal constant LP_TRUE_USDC = 2_000_000e6;
    uint256 internal constant BASE_VAULT_CAPITAL = 1_000 ether;
    uint256 internal constant QUOTE_VAULT_CAPITAL = 2_000_000e6;

    struct Deployment {
        TrueETH trueETH;
        TrueUSDC trueUSDC;
        PerpLendingVaultFactory factory;
        TruePerpHook hook;
        TruePerpRouter router;
        LendingVault baseVault;
        LendingVault quoteVault;
        PoolKey key;
        PoolId poolId;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        uint256 lpTokenId;
        bool baseIs0;
    }

    error WrongChain(uint256 actual);
    error WalletMismatch();
    error MissingInfrastructure(address target);
    error InfrastructureMismatch();
    error HookAddressMismatch();
    error MarketSetupFailed();

    function run() external returns (Deployment memory d) {
        if (block.chainid != UNICHAIN_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 deployerKey = vm.envUint("WALLET_PRIVATE_KEY");
        address owner = vm.envAddress("WALLET_ADDRESS");
        if (vm.addr(deployerKey) != owner) revert WalletMismatch();

        IPoolManager poolManager = IPoolManager(vm.envOr("POOL_MANAGER", DEFAULT_POOL_MANAGER));
        IPositionManager positionManager = IPositionManager(vm.envOr("POSITION_MANAGER", DEFAULT_POSITION_MANAGER));
        IAllowanceTransfer permit2 = IAllowanceTransfer(vm.envOr("PERMIT2", DEFAULT_PERMIT2));
        address weth = vm.envOr("WETH", CANONICAL_WETH);

        _requireCode(address(poolManager));
        _requireCode(address(positionManager));
        _requireCode(address(permit2));
        _requireCode(UNIVERSAL_CREATE2_DEPLOYER);
        _requireCode(weth);
        if (address(positionManager.poolManager()) != address(poolManager)) revert InfrastructureMismatch();
        if (address(IPositionManagerWiring(address(positionManager)).permit2()) != address(permit2)) {
            revert InfrastructureMismatch();
        }

        vm.startBroadcast(deployerKey);

        d.trueETH = new TrueETH(owner);
        d.trueUSDC = new TrueUSDC(owner);
        d.factory = new PerpLendingVaultFactory();
        d.hook = _deployHook(poolManager, d.factory, owner, weth);
        d.router = new TruePerpRouter(poolManager, d.hook, owner);

        d.baseIs0 = address(d.trueETH) < address(d.trueUSDC);
        d.sqrtPriceX96 = d.baseIs0 ? SQRT_PRICE_ETH_IS_0 : SQRT_PRICE_USDC_IS_0;
        d.key = _poolKey(d.trueETH, d.trueUSDC, d.hook, d.baseIs0);
        d.poolId = d.key.toId();

        poolManager.initialize(d.key, d.sqrtPriceX96);
        (d.baseVault, d.quoteVault) = _configureMarket(d, owner);
        (d.lpTokenId, d.liquidity) = _mintPoolLiquidity(d, positionManager, permit2, owner);
        _capitalizeVaults(d, owner);

        vm.stopBroadcast();

        _logDeployment(d, owner, address(poolManager), address(positionManager), address(permit2));
    }

    function _deployHook(IPoolManager poolManager, PerpLendingVaultFactory factory, address owner, address weth)
        internal
        returns (TruePerpHook hook)
    {
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(poolManager, factory, owner, weth);
        (address predicted, bytes32 salt) =
            HookMiner.find(UNIVERSAL_CREATE2_DEPLOYER, flags, type(TruePerpHook).creationCode, constructorArgs);

        hook = new TruePerpHook{salt: salt}(poolManager, address(factory), owner, weth);
        if (address(hook) != predicted) revert HookAddressMismatch();
    }

    function _poolKey(TrueETH trueETH, TrueUSDC trueUSDC, TruePerpHook hook, bool baseIs0)
        internal
        pure
        returns (PoolKey memory key)
    {
        Currency base = Currency.wrap(address(trueETH));
        Currency quote = Currency.wrap(address(trueUSDC));
        key = PoolKey({
            currency0: baseIs0 ? base : quote,
            currency1: baseIs0 ? quote : base,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
    }

    function _configureMarket(Deployment memory d, address owner)
        internal
        returns (LendingVault baseVault, LendingVault quoteVault)
    {
        (LendingVault vault0, LendingVault vault1,, bool enabled) = d.hook.getPool(d.poolId);
        if (!enabled || address(vault0) == address(0) || address(vault1) == address(0)) {
            revert MarketSetupFailed();
        }

        d.hook.configurePerpetual(d.poolId);
        TrueLendHook.Config memory config = d.hook.getConfig(d.poolId);
        config.maxLtBps = d.router.PERP_MAX_LT_BPS();
        d.hook.setConfig(d.poolId, config);
        d.router.activateMarket(d.key, Currency.wrap(address(d.trueETH)));

        baseVault = d.baseIs0 ? vault0 : vault1;
        quoteVault = d.baseIs0 ? vault1 : vault0;
        if (address(baseVault.asset()) != address(d.trueETH)) revert MarketSetupFailed();
        if (address(quoteVault.asset()) != address(d.trueUSDC)) revert MarketSetupFailed();
        if (d.hook.owner() != owner || d.router.owner() != owner) revert MarketSetupFailed();
    }

    function _mintPoolLiquidity(
        Deployment memory d,
        IPositionManager positionManager,
        IAllowanceTransfer permit2,
        address owner
    ) internal returns (uint256 tokenId, uint128 liquidity) {
        d.trueETH.approve(address(permit2), type(uint256).max);
        d.trueUSDC.approve(address(permit2), type(uint256).max);
        permit2.approve(address(d.trueETH), address(positionManager), type(uint160).max, type(uint48).max);
        permit2.approve(address(d.trueUSDC), address(positionManager), type(uint160).max, type(uint48).max);

        int24 tickLower = TickMath.minUsableTick(TICK_SPACING);
        int24 tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        uint256 amount0Max = d.baseIs0 ? LP_TRUE_ETH : LP_TRUE_USDC;
        uint256 amount1Max = d.baseIs0 ? LP_TRUE_USDC : LP_TRUE_ETH;

        // Keep 0.1% of each max amount as a deterministic rounding buffer.
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            d.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0Max * 999 / 1000,
            amount1Max * 999 / 1000
        );

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            d.key, tickLower, tickUpper, uint256(liquidity), uint128(amount0Max), uint128(amount1Max), owner, bytes("")
        );
        params[1] = abi.encode(d.key.currency0, d.key.currency1);

        tokenId = positionManager.nextTokenId();
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 1 hours);
        if (
            IPositionManagerWiring(address(positionManager)).ownerOf(tokenId) != owner
                || positionManager.getPositionLiquidity(tokenId) == 0
        ) {
            revert MarketSetupFailed();
        }
    }

    function _capitalizeVaults(Deployment memory d, address owner) internal {
        d.trueETH.approve(address(d.baseVault), BASE_VAULT_CAPITAL);
        d.trueUSDC.approve(address(d.quoteVault), QUOTE_VAULT_CAPITAL);
        d.baseVault.deposit(BASE_VAULT_CAPITAL, owner);
        d.quoteVault.deposit(QUOTE_VAULT_CAPITAL, owner);

        if (d.baseVault.cash() != BASE_VAULT_CAPITAL || d.quoteVault.cash() != QUOTE_VAULT_CAPITAL) {
            revert MarketSetupFailed();
        }
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingInfrastructure(target);
    }

    function _logDeployment(
        Deployment memory d,
        address owner,
        address poolManager,
        address positionManager,
        address permit2
    ) internal pure {
        console.log("=== TruePerp Unichain Sepolia deployment ===");
        console.log("Owner:", owner);
        console.log("PoolManager:", poolManager);
        console.log("PositionManager:", positionManager);
        console.log("Permit2:", permit2);
        console.log("TrueETH:", address(d.trueETH));
        console.log("TrueUSDC:", address(d.trueUSDC));
        console.log("PerpLendingVaultFactory:", address(d.factory));
        console.log("TruePerpHook:", address(d.hook));
        console.log("TruePerpRouter:", address(d.router));
        console.log("Base vault (tETH):", address(d.baseVault));
        console.log("Quote vault (tUSDC):", address(d.quoteVault));
        console.log("TrueETH is currency0:", d.baseIs0);
        console.log("Initial sqrtPriceX96:", uint256(d.sqrtPriceX96));
        console.log("LP NFT token id:", d.lpTokenId);
        console.log("LP liquidity:", uint256(d.liquidity));
        console.log("Pool id:");
        console.logBytes32(PoolId.unwrap(d.poolId));
        console.log("Oracle observations: 1 / 9");
        console.log("Next: run WarmOracle.s.sol 8 times, at least 60 seconds apart.");
    }
}
