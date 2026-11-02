// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockInheritanceRoot
/// @notice Far end of the inheritance chain below `Sealable`.
abstract contract MockInheritanceRoot is Sealable {
    /// @notice Declared two levels above the deployed contract.
    uint256 public rootValue;

    /// @notice Set `rootValue`.
    /// @param value New value.
    function setRootValue(uint256 value) external onlyOwner whenNotSealed {
        rootValue = value;
    }
}

/// @title MockInheritanceMiddle
/// @notice Middle of the inheritance chain.
abstract contract MockInheritanceMiddle is MockInheritanceRoot {
    /// @notice Declared one level above the deployed contract.
    mapping(address => uint256) public middleBalances;

    /// @notice Set one entry of `middleBalances`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setMiddleBalance(address key, uint256 value) external onlyOwner whenNotSealed {
        middleBalances[key] = value;
    }
}

/// @title MockInheritance
/// @notice Sealed mock whose variables come from a chain of base contracts.
contract MockInheritance is MockInheritanceMiddle {
    /// @notice Declared in the deployed contract itself.
    string public ownLabel;

    /// @notice Set `ownLabel`.
    /// @param value New value.
    function setOwnLabel(string calldata value) external onlyOwner whenNotSealed {
        ownLabel = value;
    }
}
