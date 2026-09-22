// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// @title A minimal escrow.
/// @notice Holds ether until the beneficiary releases it.
contract Escrow is IERC20 {
    address public immutable beneficiary;
    uint256 private balance;

    event Deposited(address indexed from, uint256 amount);

    error NotBeneficiary(address caller);

    modifier onlyBeneficiary() {
        if (msg.sender != beneficiary) {
            revert NotBeneficiary(msg.sender);
        }
        _;
    }

    constructor(address account) {
        beneficiary = account;
    }

    function deposit() external payable {
        balance += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function release() external onlyBeneficiary returns (uint256 sent) {
        sent = balance;
        balance = 0;
        (bool ok, ) = beneficiary.call{value: sent}("");
        require(ok, "transfer failed");
    }

    function assembled() internal pure returns (uint256 value) {
        assembly {
            value := add(1, 2)
        }
    }
}
