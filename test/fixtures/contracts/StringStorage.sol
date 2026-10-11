// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title StringStorage
/// @notice Fixture holding strings and byte arrays, alone and inside a mapping and an array.
/// @dev Exercises dynamic-bytes encoding: short values stored inline, long values stored as a
/// header slot plus data slots, and both composed with mapping and array recursion.
contract StringStorage {
    /// @notice String shorter than 32 bytes when set.
    string public shortText; // < 32 bytes: inline, high-order bytes
    /// @notice String of 32 bytes or more when set.
    string public longText; // >= 32 bytes: header + ceil(len/32) data slots
    /// @notice Bytes value shorter than 32 bytes when set.
    bytes public shortBlob;
    /// @notice Bytes value of 32 bytes or more when set.
    bytes public longBlob;

    // The multi-slot pipeline composed with recursion — the highest-risk composition,
    // deliberately not tested only at the top level.
    /// @notice String stored per address.
    mapping(address => string) public textByAddress;
    /// @notice Dynamic array of strings.
    string[] public texts;

    /// @notice Set `shortText`.
    /// @param value New string.
    function setShortText(string calldata value) external {
        shortText = value;
    }

    /// @notice Set `longText`.
    /// @param value New string.
    function setLongText(string calldata value) external {
        longText = value;
    }

    /// @notice Set `shortBlob`.
    /// @param value New bytes.
    function setShortBlob(bytes calldata value) external {
        shortBlob = value;
    }

    /// @notice Set `longBlob`.
    /// @param value New bytes.
    function setLongBlob(bytes calldata value) external {
        longBlob = value;
    }

    /// @notice Set one entry of `textByAddress`.
    /// @param who Address used as the mapping key.
    /// @param value String to store.
    function setTextByAddress(address who, string calldata value) external {
        textByAddress[who] = value;
    }

    /// @notice Append a string to `texts`.
    /// @param value String to append.
    function pushText(string calldata value) external {
        texts.push(value);
    }

    /// @notice Overwrite one element of `texts`.
    /// @param index Element index (reverts when out of range).
    /// @param value New string.
    function setText(uint256 index, string calldata value) external {
        texts[index] = value;
    }

    /// @notice Current length of `texts`.
    /// @return The number of elements in `texts`.
    function textsLength() external view returns (uint256) {
        return texts.length;
    }
}
