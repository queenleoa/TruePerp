// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {PoolId} from "v4-core/types/PoolId.sol";

interface IEquityFeed {
    /// net unrealized PnL currently owed to traders (negative = owed BY traders)
    function unrealizedOwed(PoolId poolId) external view returns (int256);
}

/// @title PerpVault
/// @notice The LP counterparty for one TruePerp market. LPs deposit the market's
/// cash asset and take the other side of net trader PnL, in exchange for open
/// and close fees, liquidation penalties, and the funding-skew residual — the
/// same "LPs replace keepers as the compensated absorbers" role TrueLend gives
/// its in-range LPs, here in cash-settled form.
///
/// Share accounting: LP equity = cash held − net unrealized PnL owed to traders
/// (read from the hook). Trader margin never sits here — the hook custodies it —
/// so `cash()` is purely LP capital plus realized flows.
contract PerpVault is ERC20 {
    using SafeTransferLib for ERC20;

    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    ERC20 public immutable asset;
    address public immutable hook;
    PoolId public immutable poolId;

    uint256 public totalShortfall; // lifetime trader bankruptcies absorbed by LPs

    event Deposited(address indexed lp, uint256 assets, uint256 shares);
    event Redeemed(address indexed lp, uint256 assets, uint256 shares);
    event PaidOut(address indexed to, uint256 assets);
    event ShortfallRecorded(uint256 assets);

    error OnlyHook();
    error ZeroAmount();
    error InsufficientCash();

    modifier onlyHook() {
        if (msg.sender != hook) revert OnlyHook();
        _;
    }

    constructor(ERC20 _asset, address _hook, PoolId _poolId)
        ERC20(
            string.concat("TruePerp LP ", _asset.name()),
            string.concat("tp", _asset.symbol()),
            _asset.decimals()
        )
    {
        asset = _asset;
        hook = _hook;
        poolId = _poolId;
    }

    function cash() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice LP-owned equity: cash minus what traders would take out if every
    /// position closed at the current filtered price. Floored at zero — equity
    /// below zero means pending trader wins exceed capital, and deposits price
    /// at the floor until losses realize or funding rebalances.
    function equity() public view returns (uint256) {
        int256 e = int256(cash()) - IEquityFeed(hook).unrealizedOwed(poolId);
        return e > 0 ? uint256(e) : 0;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return FullMath.mulDiv(assets, totalSupply + VIRTUAL_SHARES, equity() + VIRTUAL_ASSETS);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return FullMath.mulDiv(shares, equity() + VIRTUAL_ASSETS, totalSupply + VIRTUAL_SHARES);
    }

    // ------------------------------------------------------------------ LPs

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = convertToShares(assets);
        if (shares == 0) revert ZeroAmount();
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposited(receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        assets = convertToAssets(shares);
        if (assets > cash()) revert InsufficientCash(); // unrealized PnL must realize first
        _burn(msg.sender, shares);
        asset.safeTransfer(receiver, assets);
        emit Redeemed(msg.sender, assets, shares);
    }

    // ------------------------------------------------------------------ hook

    /// @notice Pay realized trader wins (and only those) out of LP capital.
    function payOut(address to, uint256 assets) external onlyHook {
        if (assets > cash()) revert InsufficientCash();
        asset.safeTransfer(to, assets);
        emit PaidOut(to, assets);
    }

    /// @notice A trader ran out of margin past the backstop: the uncovered loss
    /// stays with LPs. Recorded so LPs can price the tail they underwrite —
    /// the same declared-waterfall philosophy as the lending vaults.
    function recordShortfall(uint256 assets) external onlyHook {
        totalShortfall += assets;
        emit ShortfallRecorded(assets);
    }
}
