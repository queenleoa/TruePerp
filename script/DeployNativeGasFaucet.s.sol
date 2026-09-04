// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {NativeGasFaucet} from "../src/mocks/NativeGasFaucet.sol";

/// @notice Deploy the demo native-token faucet with twenty 0.05 ETH claims.
/// @dev Reads the ignored WALLET_PRIVATE_KEY environment variable, matching the
/// main deployment scripts. Never place that signer in tracked configuration.
contract DeployNativeGasFaucet is Script {
    uint256 public constant INITIAL_FUNDING = 1 ether;
    uint256 internal constant UNICHAIN_SEPOLIA_CHAIN_ID = 1301;

    error WrongChain(uint256 actual);
    error WalletMismatch();

    function run() external returns (NativeGasFaucet faucet) {
        if (block.chainid != UNICHAIN_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 deployerKey = vm.envUint("WALLET_PRIVATE_KEY");
        address relayer = vm.envAddress("WALLET_ADDRESS");
        if (vm.addr(deployerKey) != relayer) revert WalletMismatch();

        vm.startBroadcast(deployerKey);
        faucet = new NativeGasFaucet{value: INITIAL_FUNDING}(relayer);
        vm.stopBroadcast();

        console.log("Native gas faucet:", address(faucet));
        console.log("Authorized relayer:", relayer);
        console.log("Initial funding:", INITIAL_FUNDING);
        console.log("Claim amount:", faucet.CLAIM_AMOUNT());
        console.log("Initial claims available:", faucet.remainingClaims());
    }
}
