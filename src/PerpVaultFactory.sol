// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PerpVault} from "./PerpVault.sol";

/// @notice Deploys PerpVaults on behalf of the hook, keeping the vault creation
/// code out of the hook's own bytecode (the same EIP-170 device as TrueLend's
/// VaultFactory).
contract PerpVaultFactory {
    function deploy(ERC20 asset, address hook, PoolId poolId) external returns (PerpVault) {
        return new PerpVault(asset, hook, poolId);
    }
}
