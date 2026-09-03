// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "forge-std/interfaces/IERC721.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
// The PosmTestSetup fixture loads these artifacts dynamically with vm.getCode.
import {PositionDescriptor} from "v4-periphery/src/PositionDescriptor.sol";
import {PositionManager} from "v4-periphery/src/PositionManager.sol";
import {PositionConfig} from "v4-periphery/test/shared/PositionConfig.sol";
import {PosmTestSetup} from "v4-periphery/test/shared/PosmTestSetup.sol";

import {LendingVault} from "truelend/LendingVault.sol";
import {PerpLendingVaultFactory} from "../src/PerpLendingVaultFactory.sol";
import {TruePerpHook} from "../src/TruePerpHook.sol";
import {DemoFaucetToken, TrueETH, TrueUSDC} from "../src/mocks/TrueDemoTokens.sol";

contract DemoTokenTest is Test {
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    TrueETH internal trueETH;
    TrueUSDC internal trueUSDC;

    function setUp() public {
        trueETH = new TrueETH(treasury);
        trueUSDC = new TrueUSDC(treasury);
    }

    function test_trueETHMetadataSupplyCapAndFaucet() public view {
        assertEq(trueETH.name(), "TrueETH (Demo)");
        assertEq(trueETH.symbol(), "tETH");
        assertEq(trueETH.decimals(), 18);
        assertEq(trueETH.totalSupply(), trueETH.TREASURY_SUPPLY());
        assertEq(trueETH.balanceOf(treasury), trueETH.TREASURY_SUPPLY());
        assertEq(trueETH.maxSupply(), trueETH.MAX_SUPPLY());
        assertEq(trueETH.faucetAmount(), trueETH.FAUCET_AMOUNT());
        assertEq(trueETH.FAUCET_AMOUNT(), 5 ether);
    }

    function test_trueUSDCMetadataSupplyCapAndFaucet() public view {
        assertEq(trueUSDC.name(), "TrueUSDC (Demo)");
        assertEq(trueUSDC.symbol(), "tUSDC");
        assertEq(trueUSDC.decimals(), 6);
        assertEq(trueUSDC.totalSupply(), trueUSDC.TREASURY_SUPPLY());
        assertEq(trueUSDC.balanceOf(treasury), trueUSDC.TREASURY_SUPPLY());
        assertEq(trueUSDC.maxSupply(), trueUSDC.MAX_SUPPLY());
        assertEq(trueUSDC.faucetAmount(), trueUSDC.FAUCET_AMOUNT());
        assertEq(trueUSDC.FAUCET_AMOUNT(), 10_000e6);
    }

    function test_claimIsExactlyOncePerWallet() public {
        uint256 supplyBefore = trueETH.totalSupply();

        vm.prank(alice);
        uint256 amount = trueETH.claim();

        assertEq(amount, trueETH.FAUCET_AMOUNT());
        assertEq(trueETH.balanceOf(alice), trueETH.FAUCET_AMOUNT());
        assertEq(trueETH.totalSupply(), supplyBefore + trueETH.FAUCET_AMOUNT());
        assertTrue(trueETH.hasClaimed(alice));

        vm.prank(alice);
        vm.expectRevert(DemoFaucetToken.AlreadyClaimed.selector);
        trueETH.claim();

        vm.prank(bob);
        trueETH.claim();
        assertEq(trueETH.balanceOf(bob), trueETH.FAUCET_AMOUNT());
    }

    function test_smallTokenStopsAtCapAndDoesNotConsumeFailedClaim() public {
        DemoFaucetToken small = new DemoFaucetToken("Small Demo", "SMOL", 0, treasury, 2, 4, 1);
        address carol = makeAddr("carol");

        vm.prank(alice);
        small.claim();
        vm.prank(bob);
        small.claim();

        assertEq(small.totalSupply(), small.maxSupply());

        vm.prank(carol);
        vm.expectRevert(DemoFaucetToken.FaucetExhausted.selector);
        small.claim();

        assertFalse(small.hasClaimed(carol));
        assertEq(small.balanceOf(carol), 0);
        assertEq(small.totalSupply(), 4);
    }

    function test_constructorRejectsZeroTreasury() public {
        vm.expectRevert(DemoFaucetToken.ZeroAddress.selector);
        new DemoFaucetToken("Invalid", "BAD", 18, address(0), 1, 2, 1);
    }

    function test_constructorRejectsZeroTreasurySupply() public {
        vm.expectRevert(DemoFaucetToken.InvalidSupply.selector);
        new DemoFaucetToken("Invalid", "BAD", 18, treasury, 0, 2, 1);
    }

    function test_constructorRejectsZeroFaucetAmount() public {
        vm.expectRevert(DemoFaucetToken.InvalidSupply.selector);
        new DemoFaucetToken("Invalid", "BAD", 18, treasury, 1, 2, 0);
    }

    function test_constructorRejectsTreasurySupplyAboveCap() public {
        vm.expectRevert(DemoFaucetToken.InvalidSupply.selector);
        new DemoFaucetToken("Invalid", "BAD", 18, treasury, 3, 2, 1);
    }
}

/// @dev Exercises the same primitives used by the public demo deployment:
/// address-sorted mixed-decimal tokens, a raw-price-aware pool initialization,
/// hook-created isolated vaults, separate lender deposits, and an ERC-721 LP
/// position minted through Uniswap's canonical v4 PositionManager flow.
contract DemoBootstrapIntegrationTest is PosmTestSetup {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant FULL_RANGE_LOWER = -887220;
    int24 internal constant FULL_RANGE_UPPER = 887220;
    uint256 internal constant LP_LIQUIDITY = 1e16;
    uint256 internal constant BASE_VAULT_DEPOSIT = 500e18;
    uint256 internal constant QUOTE_VAULT_DEPOSIT = 1_000_000e6;

    TrueETH internal trueETH;
    TrueUSDC internal trueUSDC;
    TruePerpHook internal truePerpHook;
    PoolKey internal demoKey;
    PoolId internal demoPoolId;
    LendingVault internal baseVault;
    LendingVault internal quoteVault;
    bool internal baseIsCurrency0;
    uint160 internal initialSqrtPriceX96;

    function setUp() public {
        deployFreshManager();
        deployPosm(manager);

        trueETH = new TrueETH(address(this));
        trueUSDC = new TrueUSDC(address(this));

        baseIsCurrency0 = address(trueETH) < address(trueUSDC);
        currency0 = Currency.wrap(baseIsCurrency0 ? address(trueETH) : address(trueUSDC));
        currency1 = Currency.wrap(baseIsCurrency0 ? address(trueUSDC) : address(trueETH));
        approvePosm();

        PerpLendingVaultFactory factory = new PerpLendingVaultFactory();
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, factory, address(this), address(trueETH));
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(TruePerpHook).creationCode, constructorArgs);
        truePerpHook = new TruePerpHook{salt: salt}(manager, address(factory), address(this), address(trueETH));
        assertEq(address(truePerpHook), hookAddress);

        // v4 prices are raw currency1 units per raw currency0 unit. Account for
        // TrueETH's 18 decimals and TrueUSDC's 6 decimals in either sort order.
        initialSqrtPriceX96 = baseIsCurrency0 ? _sqrtRatioX96(2_000e6, 1e18) : _sqrtRatioX96(1e18, 2_000e6);

        demoKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: FEE, tickSpacing: TICK_SPACING, hooks: IHooks(hookAddress)
        });
        manager.initialize(demoKey, initialSqrtPriceX96);
        demoPoolId = demoKey.toId();

        (LendingVault vault0, LendingVault vault1,,) = truePerpHook.getPool(demoPoolId);
        assertEq(address(vault0.asset()), Currency.unwrap(currency0));
        assertEq(address(vault1.asset()), Currency.unwrap(currency1));
        baseVault = baseIsCurrency0 ? vault0 : vault1;
        quoteVault = baseIsCurrency0 ? vault1 : vault0;
    }

    function test_bootstrapMapsAssetsSeedsSeparateVaultsAndMintsCanonicalLP() public {
        assertLt(
            uint256(uint160(Currency.unwrap(demoKey.currency0))), uint256(uint160(Currency.unwrap(demoKey.currency1)))
        );
        assertEq(address(baseVault.asset()), address(trueETH));
        assertEq(address(quoteVault.asset()), address(trueUSDC));

        (uint160 actualSqrtPriceX96,,,) = manager.getSlot0(demoPoolId);
        assertEq(actualSqrtPriceX96, initialSqrtPriceX96);
        assertEq(initialSqrtPriceX96, baseIsCurrency0 ? _sqrtRatioX96(2_000e6, 1e18) : _sqrtRatioX96(1e18, 2_000e6));

        trueETH.approve(address(baseVault), BASE_VAULT_DEPOSIT);
        trueUSDC.approve(address(quoteVault), QUOTE_VAULT_DEPOSIT);
        uint256 baseShares = baseVault.deposit(BASE_VAULT_DEPOSIT, address(this));
        uint256 quoteShares = quoteVault.deposit(QUOTE_VAULT_DEPOSIT, address(this));

        assertGt(baseShares, 0);
        assertGt(quoteShares, 0);
        assertEq(baseVault.cash(), BASE_VAULT_DEPOSIT);
        assertEq(quoteVault.cash(), QUOTE_VAULT_DEPOSIT);
        assertEq(baseVault.totalAssets(), BASE_VAULT_DEPOSIT);
        assertEq(quoteVault.totalAssets(), QUOTE_VAULT_DEPOSIT);

        PositionConfig memory config =
            PositionConfig({poolKey: demoKey, tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER});
        uint256 tokenId = lpm.nextTokenId();
        mint(config, LP_LIQUIDITY, address(this), "");

        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(this));
        assertEq(lpm.getPositionLiquidity(tokenId), LP_LIQUIDITY);
        assertEq(manager.getLiquidity(demoPoolId), LP_LIQUIDITY);
    }

    function _sqrtRatioX96(uint256 amount1, uint256 amount0) internal pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(amount1, uint256(1) << 192, amount0);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }
}
