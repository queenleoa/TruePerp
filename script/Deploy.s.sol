// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {TruePerpHook} from "../src/TruePerpHook.sol";
import {TruePerpRouter} from "../src/TruePerpRouter.sol";
import {PerpLendingVaultFactory} from "../src/PerpLendingVaultFactory.sol";

///   POOL_MANAGER=0x... forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
contract Deploy is Script {
    address constant CREATE2_FACTORY_ADDRESS = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        address owner = vm.envAddress("WALLET_ADDRESS");
        address weth = vm.envOr("WETH", address(0x4200000000000000000000000000000000000006));

        vm.startBroadcast();
        PerpLendingVaultFactory factory = new PerpLendingVaultFactory();

        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(poolManager, factory, owner, weth);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY_ADDRESS, flags, type(TruePerpHook).creationCode, constructorArgs);

        TruePerpHook hook = new TruePerpHook{salt: salt}(poolManager, address(factory), owner, weth);
        require(address(hook) == hookAddress, "hook address mismatch");
        TruePerpRouter router = new TruePerpRouter(poolManager, hook, owner);
        vm.stopBroadcast();

        console.log("PerpLendingVaultFactory:", address(factory));
        console.log("TruePerpHook:", address(hook));
        console.log("TruePerpRouter:", address(router));
        console.log("owner:", hook.owner());
        console.log("Next: initialize pool, configurePerpetual(poolId), then router.activateMarket(key, BASE)");
    }
}
