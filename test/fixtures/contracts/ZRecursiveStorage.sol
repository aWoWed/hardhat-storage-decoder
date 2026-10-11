// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ZRecursiveStorage
/// @notice Fixture holding a struct that refers to itself through an array and a mapping.
/// @dev Exercises recursive struct types, a nested mapping, and a packed uint8 array. Named to
/// sort LAST among the fixtures, so adding it does not shift the AST ids baked into the other
/// contracts' type ids.
contract ZRecursiveStorage {
    /// @notice A tree node that contains child nodes in an array and in a mapping.
    struct Node {
        /// @dev This node's identifier.
        uint256 id;
        /// @dev Child nodes, stored as a dynamic array of the same struct.
        Node[] children;
        /// @dev Child nodes by numeric key, stored as a mapping to the same struct.
        mapping(uint256 => Node) byId;
    }

    /// @dev Root of the tree (internal, so no getter).
    Node internal root;
    /// @notice Number stored per (address, uint256) key pair.
    mapping(address => mapping(uint256 => uint256)) public grid;
    /// @dev Packed uint8 array (internal, so no getter).
    uint8[] internal tiny; // 32 elements per slot

    /// @notice Set the root node's id.
    /// @param id New id.
    function setRootId(uint256 id) external {
        root.id = id;
    }

    /// @notice Append a child to the root's `children`.
    /// @param id Id of the new child.
    function addChild(uint256 id) external {
        root.children.push().id = id;
    }

    /// @notice Append a grandchild under an existing child of the root.
    /// @param childIndex Index of the parent in the root's `children`.
    /// @param id Id of the new grandchild.
    function addGrandchild(uint256 childIndex, uint256 id) external {
        root.children[childIndex].children.push().id = id;
    }

    /// @notice Set the id of the root's `byId` entry.
    /// @param key Key into the root's `byId` mapping.
    /// @param id New id.
    function setById(uint256 key, uint256 id) external {
        root.byId[key].id = id;
    }

    /// @notice Append a value to `tiny`.
    /// @param value Value to append.
    function pushTiny(uint8 value) external {
        tiny.push(value);
    }

    /// @notice Set one entry of `grid`.
    /// @param who First-level key.
    /// @param key Second-level key.
    /// @param value Value to store.
    function setGrid(address who, uint256 key, uint256 value) external {
        grid[who][key] = value;
    }
}
