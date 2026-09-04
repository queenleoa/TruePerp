// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title NativeGasFaucet
/// @notice Dispenses one fixed native-token allocation per address for the
/// TruePerp Unichain Sepolia demo.
/// @dev This is a convenience faucet for a public testnet, not a production
/// distribution mechanism. The trusted demo relayer is responsible for
/// authenticating requests offchain. Anyone may refill the faucet.
contract NativeGasFaucet {
    uint256 public constant CLAIM_AMOUNT = 0.05 ether;

    address private immutable _RELAYER;
    mapping(address account => bool claimed) public hasClaimed;
    uint256 public totalClaims;
    bool private claimInProgress;

    event FaucetFunded(address indexed funder, uint256 amount, uint256 newBalance);
    event FaucetClaimed(address indexed account, address indexed caller, uint256 amount, uint256 remainingBalance);

    error ZeroAddress();
    error Unauthorized();
    error AlreadyClaimed();
    error InsufficientBalance(uint256 available, uint256 required);
    error NativeTransferFailed();
    error ReentrantClaim();
    error ZeroFunding();

    modifier onlyRelayer() {
        _checkRelayer();
        _;
    }

    modifier nonReentrantClaim() {
        _beforeClaim();
        _;
        _afterClaim();
    }

    function _beforeClaim() private {
        if (claimInProgress) revert ReentrantClaim();
        claimInProgress = true;
    }

    function _afterClaim() private {
        claimInProgress = false;
    }

    function _checkRelayer() private view {
        if (msg.sender != _RELAYER) revert Unauthorized();
    }

    constructor(address relayer_) payable {
        if (relayer_ == address(0)) revert ZeroAddress();
        _RELAYER = relayer_;
        if (msg.value != 0) emit FaucetFunded(msg.sender, msg.value, msg.value);
    }

    /// @notice The sole account authorized to relay verified demo claims.
    function relayer() external view returns (address) {
        return _RELAYER;
    }

    /// @notice The fixed amount sent by each successful claim.
    function claimAmount() external pure returns (uint256) {
        return CLAIM_AMOUNT;
    }

    /// @notice Return how many complete claims the current balance can fund.
    function remainingClaims() external view returns (uint256) {
        return address(this).balance / CLAIM_AMOUNT;
    }

    /// @notice Send an allocation to a verified address while the relayer pays
    /// gas. Eligibility is consumed by `recipient`, not by the relayer.
    function claimFor(address payable recipient) external onlyRelayer nonReentrantClaim returns (uint256 amount) {
        return _claim(recipient);
    }

    function _claim(address payable recipient) internal returns (uint256 amount) {
        if (recipient == address(0)) revert ZeroAddress();
        if (hasClaimed[recipient]) revert AlreadyClaimed();

        amount = CLAIM_AMOUNT;
        uint256 balance = address(this).balance;
        if (balance < amount) revert InsufficientBalance(balance, amount);

        // Effects precede the external call. A failed transfer reverts these
        // writes, so the caller may retry after making itself payable.
        hasClaimed[recipient] = true;
        unchecked {
            ++totalClaims;
        }

        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert NativeTransferFailed();

        emit FaucetClaimed(recipient, msg.sender, amount, address(this).balance);
    }

    /// @notice Refill the public demo faucet with native test ETH.
    function fund() external payable {
        if (msg.value == 0) revert ZeroFunding();
        emit FaucetFunded(msg.sender, msg.value, address(this).balance);
    }

    receive() external payable {
        emit FaucetFunded(msg.sender, msg.value, address(this).balance);
    }
}
