// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IERC20Like
/// @notice Minimal token interface used only as a contract-typed storage value and mapping key.
/// @dev Contract types are stored and keyed as addresses.
interface IERC20Like {
    /// @notice Total token supply.
    /// @return The total supply.
    function totalSupply() external view returns (uint256);
}

/// @title EnumAndContractStorage
/// @notice Fixture holding an enum, a contract-typed variable, and mappings keyed by each.
/// @dev Exercises enum storage as a 1-byte uint8, contract types as 20-byte addresses, packing
/// of the two into one slot, and address-/uint8-encoded mapping keys.
contract EnumAndContractStorage {
    /// @notice Lifecycle states, stored as a uint8.
    enum Status {
        /// @dev Value 0.
        Pending,
        /// @dev Value 1.
        Active,
        /// @dev Value 2.
        Closed
    }

    /// @notice Current status.
    Status public status; // slot 0, offset 0, 1 byte
    /// @notice Token contract reference.
    IERC20Like public token; // slot 0, offset 1, 20 bytes (packs with the enum)

    /// @notice Number stored per token contract.
    mapping(IERC20Like => uint256) public byToken; // address-encoded key
    /// @notice Number stored per status.
    mapping(Status => uint256) public byStatus; // uint8-encoded key

    /// @notice Set `status`.
    /// @param status_ New status.
    function setStatus(Status status_) external {
        status = status_;
    }

    /// @notice Set `token`.
    /// @param token_ New token reference.
    function setToken(IERC20Like token_) external {
        token = token_;
    }

    /// @notice Set one entry of `byToken`.
    /// @param key Token contract used as the mapping key.
    /// @param value Value to store.
    function setByToken(IERC20Like key, uint256 value) external {
        byToken[key] = value;
    }

    /// @notice Set one entry of `byStatus`.
    /// @param key Status used as the mapping key.
    /// @param value Value to store.
    function setByStatus(Status key, uint256 value) external {
        byStatus[key] = value;
    }
}
