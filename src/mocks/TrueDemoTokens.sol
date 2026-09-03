// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @title DemoFaucetToken
/// @notice A capped, unbacked test token with one fixed faucet claim per wallet.
/// @dev This contract is intentionally unsuitable for production assets. There
/// is no privileged mint path after construction and no redemption promise.
contract DemoFaucetToken is ERC20 {
    uint256 public immutable maxSupply;
    uint256 public immutable faucetAmount;

    mapping(address account => bool claimed) public hasClaimed;

    event FaucetClaimed(address indexed account, uint256 amount);

    error ZeroAddress();
    error InvalidSupply();
    error AlreadyClaimed();
    error FaucetExhausted();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address treasury,
        uint256 treasurySupply,
        uint256 maxSupply_,
        uint256 faucetAmount_
    ) ERC20(name_, symbol_, decimals_) {
        if (treasury == address(0)) revert ZeroAddress();
        if (treasurySupply == 0 || faucetAmount_ == 0 || treasurySupply > maxSupply_) revert InvalidSupply();

        maxSupply = maxSupply_;
        faucetAmount = faucetAmount_;
        _mint(treasury, treasurySupply);
    }

    /// @notice Mint the fixed demo allocation once to the caller.
    function claim() external returns (uint256 amount) {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        amount = faucetAmount;
        if (totalSupply + amount > maxSupply) revert FaucetExhausted();

        // Effects precede the mint even though Solmate's _mint has no callback.
        hasClaimed[msg.sender] = true;
        _mint(msg.sender, amount);
        emit FaucetClaimed(msg.sender, amount);
    }
}

/// @notice Unbacked 18-decimal ETH-like asset for the TruePerp testnet demo.
contract TrueETH is DemoFaucetToken {
    uint256 public constant TREASURY_SUPPLY = 10_000 ether;
    uint256 public constant MAX_SUPPLY = 20_000 ether;
    uint256 public constant FAUCET_AMOUNT = 5 ether;

    constructor(address treasury)
        DemoFaucetToken("TrueETH (Demo)", "tETH", 18, treasury, TREASURY_SUPPLY, MAX_SUPPLY, FAUCET_AMOUNT)
    {}
}

/// @notice Unbacked 6-decimal USD-like asset for the TruePerp testnet demo.
contract TrueUSDC is DemoFaucetToken {
    uint256 public constant TREASURY_SUPPLY = 20_000_000e6;
    uint256 public constant MAX_SUPPLY = 40_000_000e6;
    uint256 public constant FAUCET_AMOUNT = 10_000e6;

    constructor(address treasury)
        DemoFaucetToken("TrueUSDC (Demo)", "tUSDC", 6, treasury, TREASURY_SUPPLY, MAX_SUPPLY, FAUCET_AMOUNT)
    {}
}
