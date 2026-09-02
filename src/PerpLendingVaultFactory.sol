// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {LendingVault} from "truelend/LendingVault.sol";

/// @title PerpLendingVaultFactory
/// @notice Deploys the two supporting debt vaults for a TruePerp market.
/// @dev The hackathon profile deliberately fixes borrow carry at zero. The
/// inherited liquidation ranges are registered once at opening; variable debt
/// growth would otherwise create interest-only risk without moving through a
/// trigger tick. A production carry model requires dynamic trigger refresh and
/// is intentionally outside this mechanism demo.
contract PerpLendingVaultFactory {
    uint16 public constant KINK_BPS = 8000;
    uint16 public constant UTILIZATION_CAP_BPS = 9000;

    function deploy(ERC20 asset, address hook) external returns (LendingVault) {
        return new LendingVault(
            asset,
            hook,
            0, // base rate
            0, // slope before kink
            KINK_BPS,
            0, // slope after kink
            UTILIZATION_CAP_BPS,
            0, // no interest means no reserve-factor accrual
            0 // rate ceiling
        );
    }
}
