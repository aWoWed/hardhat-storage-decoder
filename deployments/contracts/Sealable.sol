// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Sealable
/// @notice Base of every public mock: only the deployer may write, and only until `seal()`.
/// @dev `isSealed` rather than `sealed`, which is a reserved word in Solidity. There is no way
/// to unseal or to change the owner, so a sealed mock's storage can never change again.
abstract contract Sealable {
    /// @notice The deployer, the only account allowed to write.
    address public owner;
    /// @notice True once `seal()` has run. Packed into slot 0 with `owner`.
    bool public isSealed;

    /// @notice The caller is not the owner.
    error NotOwner();
    /// @notice The contract has been sealed.
    error AlreadySealed();

    /// @notice Emitted once, when the contract is sealed.
    event Sealed();

    /// @dev Checked first, so an outsider gets `NotOwner` whether or not the contract is sealed.
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Reverts after `seal()`, including for the owner.
    modifier whenNotSealed() {
        if (isSealed) revert AlreadySealed();
        _;
    }

    /// @dev Records the deployer as the owner.
    constructor() {
        owner = msg.sender;
    }

    /// @notice Stop all further writes, permanently.
    function seal() external onlyOwner whenNotSealed {
        isSealed = true;
        emit Sealed();
    }
}
