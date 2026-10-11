// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MappingToArrayStorage
/// @notice Fixture holding mappings whose values are dynamic arrays.
/// @dev Exercises the case where a mapping's derived slot becomes an array's own header slot,
/// including packed element arrays and a mapping nested in front of the array.
contract MappingToArrayStorage {
    // A mapping's derived slot becomes an array's own header slot.
    /// @notice Word list per address.
    mapping(address => uint256[]) public listByAddress;
    /// @notice Packed uint96 list per address.
    mapping(address => uint96[]) public packedListByAddress;
    /// @notice Word list per address and numeric key.
    mapping(address => mapping(uint256 => uint256[])) public nestedListByAddress;

    /// @notice Append values to an address's `listByAddress` entry.
    /// @param who Address whose list is extended.
    /// @param values Words to append.
    function pushList(address who, uint256[] calldata values) external {
        for (uint256 i = 0; i < values.length; i++) listByAddress[who].push(values[i]);
    }

    /// @notice Append values to an address's `packedListByAddress` entry.
    /// @param who Address whose list is extended.
    /// @param values uint96 values to append.
    function pushPackedList(address who, uint96[] calldata values) external {
        for (uint256 i = 0; i < values.length; i++) packedListByAddress[who].push(values[i]);
    }

    /// @notice Append values to a `nestedListByAddress` entry.
    /// @param who First-level mapping key.
    /// @param key Second-level mapping key.
    /// @param values Words to append.
    function pushNestedList(address who, uint256 key, uint256[] calldata values) external {
        for (uint256 i = 0; i < values.length; i++) nestedListByAddress[who][key].push(values[i]);
    }

    /// @notice Length of an address's `listByAddress` entry.
    /// @param who Address to look up.
    /// @return The number of elements in the list.
    function listLength(address who) external view returns (uint256) {
        return listByAddress[who].length;
    }
}
