// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockEnums
/// @notice Sealed mock holding enums as a variable, a mapping key and array elements.
contract MockEnums is Sealable {
    /// @notice Lifecycle states, stored as a uint8.
    enum Status {
        /// @dev Value 0.
        Pending,
        /// @dev Value 1.
        Active,
        /// @dev Value 2.
        Closed
    }

    /// @notice An enum variable.
    Status public status;
    /// @notice Number stored per `Status` key.
    mapping(Status => uint256) public countByStatus;
    /// @notice Enum elements, packing into shared slots.
    Status[] public history;

    /// @notice Set `status`.
    /// @param value New value.
    function setStatus(Status value) external onlyOwner whenNotSealed {
        status = value;
    }

    /// @notice Set one entry of `countByStatus`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setCountByStatus(Status key, uint256 value) external onlyOwner whenNotSealed {
        countByStatus[key] = value;
    }

    /// @notice Append to `history`.
    /// @param value Value to append.
    function pushHistory(Status value) external onlyOwner whenNotSealed {
        history.push(value);
    }
}
