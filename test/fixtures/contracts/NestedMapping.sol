// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title NestedMapping
/// @notice Fixture holding mappings keyed by many different key types.
/// @dev Exercises mapping slot derivation for each key family: dynamic string/bytes keys
/// (unpadded), sign-extended ints, right-padded bytesN, bool and small uints, plus a
/// three-level nested mapping.
contract NestedMapping {
    // Three levels — enough to prove the iterative re-hash has no depth limit.
    /// @notice Number stored per (address, address, uint256) key triple.
    mapping(address => mapping(address => mapping(uint256 => uint256))) public triple;

    /// @notice Number stored per string key.
    mapping(string => uint256) public byName; // unpadded key
    /// @notice Number stored per bytes key.
    mapping(bytes => uint256) public byBlob; // unpadded key
    /// @notice Number stored per int256 key.
    mapping(int256 => uint256) public bySigned; // sign-extended key
    /// @notice Number stored per bytes4 key.
    mapping(bytes4 => uint256) public bySelector; // RIGHT-padded key
    /// @notice Number stored per bool key.
    mapping(bool => uint256) public byFlag;
    /// @notice Number stored per uint8 key.
    mapping(uint8 => uint256) public bySmallUint;

    /// @notice Set one entry of `triple`.
    /// @param a First-level key.
    /// @param b Second-level key.
    /// @param c Third-level key.
    /// @param value Value to store.
    function setTriple(address a, address b, uint256 c, uint256 value) external {
        triple[a][b][c] = value;
    }

    /// @notice Set one entry of `byName`.
    /// @param name String key.
    /// @param value Value to store.
    function setByName(string calldata name, uint256 value) external {
        byName[name] = value;
    }

    /// @notice Set one entry of `byBlob`.
    /// @param blob Bytes key.
    /// @param value Value to store.
    function setByBlob(bytes calldata blob, uint256 value) external {
        byBlob[blob] = value;
    }

    /// @notice Set one entry of `bySigned`.
    /// @param key Signed integer key.
    /// @param value Value to store.
    function setBySigned(int256 key, uint256 value) external {
        bySigned[key] = value;
    }

    /// @notice Set one entry of `bySelector`.
    /// @param key bytes4 key.
    /// @param value Value to store.
    function setBySelector(bytes4 key, uint256 value) external {
        bySelector[key] = value;
    }

    /// @notice Set one entry of `byFlag`.
    /// @param key Bool key.
    /// @param value Value to store.
    function setByFlag(bool key, uint256 value) external {
        byFlag[key] = value;
    }

    /// @notice Set one entry of `bySmallUint`.
    /// @param key uint8 key.
    /// @param value Value to store.
    function setBySmallUint(uint8 key, uint256 value) external {
        bySmallUint[key] = value;
    }
}
