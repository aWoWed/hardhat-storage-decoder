// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title StructStorage
/// @notice Fixture holding multi-slot structs, nested structs, and structs inside containers.
/// @dev Exercises struct member slot offsets, a struct nested in a struct, a struct array inside
/// a mapping, a struct as a mapping value, and a fixed array of structs.
contract StructStorage {
    /// @notice A four-member struct spanning three slots.
    struct Inner {
        /// @dev Low half of the first slot.
        uint128 a; // slot +0, offset 0
        /// @dev High half of the first slot.
        uint128 b; // slot +0, offset 16
        /// @dev Second slot.
        address c; // slot +1, offset 0
        /// @dev Third slot.
        uint256 d; // slot +2, offset 0
    }

    /// @notice A struct that embeds an `Inner`.
    struct Outer {
        /// @dev Leading small member, followed by the whole-slot `inner`.
        uint64 id;
        /// @dev Nested struct; starts on a fresh slot.
        Inner inner;
        /// @dev Trailing full-slot member after the nested struct.
        uint256 tail;
    }

    // struct nested in an array nested in a mapping
    /// @notice List of `Inner` structs per address.
    mapping(address => Inner[]) public records;

    /// @notice A single `Outer` struct stored inline.
    Outer public outer;
    /// @notice `Outer` struct per numeric key.
    mapping(uint256 => Outer) public outers;
    /// @notice Fixed array of two `Inner` structs.
    Inner[2] public fixedInners;

    /// @notice Append an `Inner` to an address's `records` list.
    /// @param who Address whose list is extended.
    /// @param value Struct to append.
    function pushRecord(address who, Inner calldata value) external {
        records[who].push(value);
    }

    /// @notice Set `outer`.
    /// @param value New struct value.
    function setOuter(Outer calldata value) external {
        outer = value;
    }

    /// @notice Set one entry of `outers`.
    /// @param key Numeric mapping key.
    /// @param value Struct to store.
    function setOuters(uint256 key, Outer calldata value) external {
        outers[key] = value;
    }

    /// @notice Set one element of `fixedInners`.
    /// @param index Element index (reverts when out of range).
    /// @param value Struct to store.
    function setFixedInner(uint256 index, Inner calldata value) external {
        fixedInners[index] = value;
    }

    /// @notice Length of an address's `records` list.
    /// @param who Address to look up.
    /// @return The number of elements in the list.
    function recordsLength(address who) external view returns (uint256) {
        return records[who].length;
    }
}
