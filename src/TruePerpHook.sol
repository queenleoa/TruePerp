// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {TrueLendHook} from "truelend/TrueLendHook.sol";
import {VaultFactory} from "truelend/VaultFactory.sol";

/// @title TruePerpHook
/// @notice The TrueLend physical-liquidation kernel specialized by TruePerp's
/// market router into expiry-free leveraged longs and shorts.
///
/// A position owns one currency of its attached Uniswap pool and owes the other
/// currency to an isolated LendingVault. The inherited hook indexes maintenance
/// boundaries, observes ordinary pool flow, sells collateral through the same
/// pool in paced chunks, donates the liquidation penalty to active Uniswap LPs,
/// and repays the debt vault. There is no synthetic house or keeper vault.
///
/// Product metadata and quote-margin construction live in TruePerpRouter to keep
/// this hook below EIP-170. The hook is intentionally a thin subtype: its runtime
/// is the tested TrueLend liquidation engine plus one perpetual-horizon setter.
///
/// Prototype boundary: TrueLend's lower-level `open` entrypoint remains public.
/// The router is therefore the canonical TruePerp market interface, not an
/// on-chain access-control boundary. A production fork should remove the generic
/// loan surface or authorize only a market router after slimming the core.
contract TruePerpHook is TrueLendHook {
    /// @param factory Address of a contract implementing VaultFactory.deploy.
    /// TruePerp supplies PerpLendingVaultFactory, which has the same selector but
    /// deliberately deploys zero-carry debt vaults.
    constructor(IPoolManager manager, address factory, address owner_, address weth)
        TrueLendHook(manager, VaultFactory(factory), owner_, weth)
    {}

    /// @notice Set the longest representable horizon (~136 years), used by the
    /// prototype as its no-scheduled-expiry sentinel. All other risk fields stay
    /// unchanged and remain configurable through setConfig.
    function configurePerpetual(PoolId poolId) external onlyOwner {
        configs[poolId].termSeconds = type(uint32).max;
    }
}
