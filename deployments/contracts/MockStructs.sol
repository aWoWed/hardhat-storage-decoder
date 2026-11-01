// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockStructs
/// @notice Sealed mock holding structs: packed, nested, in a mapping, in an array, and recursive.
contract MockStructs is Sealable {
    /// @notice Inner struct, with two fields sharing a slot.
    struct Point {
        /// @dev Offset 0.
        uint128 x;
        /// @dev Offset 16.
        int128 y;
    }

    /// @notice Struct with a nested struct and dynamic fields.
    struct Position {
        /// @dev Full slot.
        uint256 id;
        /// @dev Offset 0 of its slot.
        address holder;
        /// @dev Offset 20, packed behind `holder`.
        bool active;
        /// @dev Nested struct, starting a new slot.
        Point point;
        /// @dev Dynamic string field.
        string label;
        /// @dev Dynamic array field.
        uint256[] history;
    }

    /// @notice Struct that refers to itself through a mapping.
    struct Node {
        /// @dev This node's value.
        uint256 value;
        /// @dev Child nodes by key.
        mapping(uint256 => Node) children;
    }

    /// @dev A single struct. Internal, since a getter would leave out `history`.
    Position internal position;
    /// @dev Structs in a mapping.
    mapping(address => Position) internal positions;
    /// @notice Structs in a dynamic array.
    Point[] public points;
    /// @dev Root of a recursive struct.
    Node internal root;

    /// @notice Set the fixed-size fields of `position`.
    /// @param id New `id`.
    /// @param holder New `holder`.
    /// @param active New `active`.
    /// @param point New `point`.
    function setPosition(
        uint256 id,
        address holder,
        bool active,
        Point calldata point
    ) external onlyOwner whenNotSealed {
        position.id = id;
        position.holder = holder;
        position.active = active;
        position.point = point;
    }

    /// @notice Set the label of `position`.
    /// @param label New `label`.
    function setPositionLabel(string calldata label) external onlyOwner whenNotSealed {
        position.label = label;
    }

    /// @notice Append to the history of `position`.
    /// @param value Value to append.
    function pushPositionHistory(uint256 value) external onlyOwner whenNotSealed {
        position.history.push(value);
    }

    /// @notice Set one entry of `positions`.
    /// @param key Key to set.
    /// @param id New `id`.
    /// @param label New `label`.
    function setPositionsEntry(address key, uint256 id, string calldata label) external onlyOwner whenNotSealed {
        positions[key].id = id;
        positions[key].label = label;
    }

    /// @notice Append to `points`.
    /// @param point Value to append.
    function pushPoint(Point calldata point) external onlyOwner whenNotSealed {
        points.push(point);
    }

    /// @notice Set the value of `root`.
    /// @param value New value.
    function setRootValue(uint256 value) external onlyOwner whenNotSealed {
        root.value = value;
    }

    /// @notice Set the value of a child two levels below `root`.
    /// @param first Key below `root`.
    /// @param second Key below that.
    /// @param value New value.
    function setGrandchildValue(uint256 first, uint256 second, uint256 value) external onlyOwner whenNotSealed {
        root.children[first].children[second].value = value;
    }
}
