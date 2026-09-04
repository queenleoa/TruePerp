// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {NativeGasFaucet} from "../src/mocks/NativeGasFaucet.sol";

contract ReentrantRelayer {
    NativeGasFaucet internal faucet;
    address payable public reentryTarget;
    bool public reentryBlocked;

    function setFaucet(NativeGasFaucet faucet_, address payable reentryTarget_) external {
        require(address(faucet) == address(0), "faucet already set");
        faucet = faucet_;
        reentryTarget = reentryTarget_;
    }

    function relay(address payable recipient) external {
        faucet.claimFor(recipient);
    }

    receive() external payable {
        try faucet.claimFor(reentryTarget) {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
    }
}

contract RejectingRecipient {
    receive() external payable {
        revert("reject native ETH");
    }
}

contract NativeGasFaucetTest is Test {
    uint256 internal constant INITIAL_FUNDING = 1 ether;
    uint256 internal constant CLAIM_AMOUNT = 0.05 ether;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal funder = makeAddr("funder");
    address internal relayer = makeAddr("relayer");

    NativeGasFaucet internal faucet;

    function setUp() public {
        faucet = new NativeGasFaucet{value: INITIAL_FUNDING}(relayer);
    }

    function test_initialFundingProvidesTwentyClaims() public view {
        assertEq(address(faucet).balance, INITIAL_FUNDING);
        assertEq(faucet.CLAIM_AMOUNT(), CLAIM_AMOUNT);
        assertEq(faucet.claimAmount(), CLAIM_AMOUNT);
        assertEq(faucet.remainingClaims(), 20);
        assertEq(faucet.totalClaims(), 0);
        assertEq(faucet.relayer(), relayer);
    }

    function test_relayerSendsExactlyPointZeroFiveEthOnce() public {
        vm.expectEmit(true, false, false, true, address(faucet));
        emit NativeGasFaucet.FaucetClaimed(alice, relayer, CLAIM_AMOUNT, INITIAL_FUNDING - CLAIM_AMOUNT);

        vm.prank(relayer);
        uint256 amount = faucet.claimFor(payable(alice));

        assertEq(amount, CLAIM_AMOUNT);
        assertEq(alice.balance, CLAIM_AMOUNT);
        assertEq(address(faucet).balance, INITIAL_FUNDING - CLAIM_AMOUNT);
        assertEq(faucet.remainingClaims(), 19);
        assertEq(faucet.totalClaims(), 1);
        assertTrue(faucet.hasClaimed(alice));

        vm.prank(relayer);
        vm.expectRevert(NativeGasFaucet.AlreadyClaimed.selector);
        faucet.claimFor(payable(alice));
    }

    function test_relayerCanFundARecipientWithZeroNativeBalance() public {
        assertEq(alice.balance, 0);

        vm.expectEmit(true, true, false, true, address(faucet));
        emit NativeGasFaucet.FaucetClaimed(alice, relayer, CLAIM_AMOUNT, INITIAL_FUNDING - CLAIM_AMOUNT);
        vm.prank(relayer);
        uint256 amount = faucet.claimFor(payable(alice));

        assertEq(amount, CLAIM_AMOUNT);
        assertEq(alice.balance, CLAIM_AMOUNT);
        assertEq(relayer.balance, 0);
        assertTrue(faucet.hasClaimed(alice));
        assertFalse(faucet.hasClaimed(relayer));
        assertEq(faucet.totalClaims(), 1);
    }

    function test_unauthorizedCallerCannotClaimForRecipient() public {
        vm.prank(alice);
        vm.expectRevert(NativeGasFaucet.Unauthorized.selector);
        faucet.claimFor(payable(bob));

        assertEq(bob.balance, 0);
        assertFalse(faucet.hasClaimed(bob));
        assertEq(faucet.totalClaims(), 0);
    }

    function test_claimForUsesRecipientForOneClaimAccounting() public {
        vm.prank(relayer);
        faucet.claimFor(payable(alice));

        vm.prank(relayer);
        vm.expectRevert(NativeGasFaucet.AlreadyClaimed.selector);
        faucet.claimFor(payable(alice));

        assertTrue(faucet.hasClaimed(alice));
        assertFalse(faucet.hasClaimed(funder));
        assertFalse(faucet.hasClaimed(bob));
    }

    function test_claimForRejectsZeroRecipient() public {
        vm.prank(relayer);
        vm.expectRevert(NativeGasFaucet.ZeroAddress.selector);
        faucet.claimFor(payable(address(0)));
    }

    function test_constructorRejectsZeroRelayer() public {
        vm.expectRevert(NativeGasFaucet.ZeroAddress.selector);
        new NativeGasFaucet(address(0));
    }

    function test_differentWalletsCanClaim() public {
        vm.prank(relayer);
        faucet.claimFor(payable(alice));

        vm.prank(relayer);
        faucet.claimFor(payable(bob));

        assertEq(alice.balance, CLAIM_AMOUNT);
        assertEq(bob.balance, CLAIM_AMOUNT);
        assertEq(faucet.totalClaims(), 2);
        assertEq(faucet.remainingClaims(), 18);
    }

    function test_exhaustionDoesNotConsumeClaimEligibility() public {
        address lastClaimant;
        for (uint256 i; i < 20; ++i) {
            address claimant = makeAddr(string.concat("claimant-", vm.toString(i)));
            vm.prank(relayer);
            faucet.claimFor(payable(claimant));
            lastClaimant = claimant;
        }

        assertEq(address(faucet).balance, 0);
        assertEq(faucet.remainingClaims(), 0);
        assertEq(lastClaimant.balance, CLAIM_AMOUNT);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(NativeGasFaucet.InsufficientBalance.selector, 0, CLAIM_AMOUNT));
        faucet.claimFor(payable(alice));

        assertFalse(faucet.hasClaimed(alice));
        assertEq(faucet.totalClaims(), 20);
    }

    function test_permissionlessFundRestoresClaimCapacity() public {
        vm.deal(funder, 0.1 ether);

        vm.expectEmit(true, false, false, true, address(faucet));
        emit NativeGasFaucet.FaucetFunded(funder, 0.1 ether, 1.1 ether);
        vm.prank(funder);
        faucet.fund{value: 0.1 ether}();

        assertEq(address(faucet).balance, 1.1 ether);
        assertEq(faucet.remainingClaims(), 22);
    }

    function test_receiveAlsoRefillsFaucet() public {
        vm.deal(funder, CLAIM_AMOUNT);

        vm.expectEmit(true, false, false, true, address(faucet));
        emit NativeGasFaucet.FaucetFunded(funder, CLAIM_AMOUNT, INITIAL_FUNDING + CLAIM_AMOUNT);
        vm.prank(funder);
        (bool success,) = address(faucet).call{value: CLAIM_AMOUNT}("");

        assertTrue(success);
        assertEq(faucet.remainingClaims(), 21);
    }

    function test_zeroValueExplicitFundingReverts() public {
        vm.expectRevert(NativeGasFaucet.ZeroFunding.selector);
        faucet.fund();
    }

    function test_reentrantRelayerReceivesOnlyOneClaim() public {
        address payable reentryTarget = payable(makeAddr("reentry-target"));
        ReentrantRelayer maliciousRelayer = new ReentrantRelayer();
        NativeGasFaucet guardedFaucet = new NativeGasFaucet{value: INITIAL_FUNDING}(address(maliciousRelayer));
        maliciousRelayer.setFaucet(guardedFaucet, reentryTarget);

        maliciousRelayer.relay(payable(address(maliciousRelayer)));

        assertTrue(maliciousRelayer.reentryBlocked());
        assertTrue(guardedFaucet.hasClaimed(address(maliciousRelayer)));
        assertFalse(guardedFaucet.hasClaimed(reentryTarget));
        assertEq(address(maliciousRelayer).balance, CLAIM_AMOUNT);
        assertEq(guardedFaucet.totalClaims(), 1);
        assertEq(address(guardedFaucet).balance, INITIAL_FUNDING - CLAIM_AMOUNT);
    }

    function test_failedNativeTransferRollsBackClaimState() public {
        RejectingRecipient recipient = new RejectingRecipient();

        vm.prank(relayer);
        vm.expectRevert(NativeGasFaucet.NativeTransferFailed.selector);
        faucet.claimFor(payable(address(recipient)));

        assertFalse(faucet.hasClaimed(address(recipient)));
        assertEq(faucet.totalClaims(), 0);
        assertEq(address(faucet).balance, INITIAL_FUNDING);
    }
}
