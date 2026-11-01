// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockMappings
/// @notice Sealed mock holding mappings with each key encoding, including nested ones.
/// @dev The key types pad differently in the slot hash: address and uint left-padded, int
/// sign-extended, bytes32 as is, string and bytes hashed unpadded.
contract MockMappings is Sealable {
    /// @notice Keyed by address.
    mapping(address => uint256) public byAddress;
    /// @notice Keyed by uint.
    mapping(uint256 => uint256) public byUint;
    /// @notice Keyed by a signed integer narrower than a word.
    mapping(int64 => uint256) public byInt;
    /// @notice Keyed by bytes32.
    mapping(bytes32 => uint256) public byBytes32;
    /// @notice Keyed by string.
    mapping(string => uint256) public byString;
    /// @notice Keyed by bytes.
    mapping(bytes => uint256) public byBytes;
    /// @notice Two levels.
    mapping(address => mapping(uint256 => uint256)) public nested;
    /// @notice Three levels, with a dynamic key in the middle.
    mapping(address => mapping(string => mapping(uint256 => bool))) public deep;
    /// @notice Mapping to a dynamic array.
    mapping(uint256 => uint256[]) public lists;

    /// @notice Set one entry of `byAddress`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setByAddress(address key, uint256 value) external onlyOwner whenNotSealed {
        byAddress[key] = value;
    }

    /// @notice Set one entry of `byUint`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setByUint(uint256 key, uint256 value) external onlyOwner whenNotSealed {
        byUint[key] = value;
    }

    /// @notice Set one entry of `byInt`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setByInt(int64 key, uint256 value) external onlyOwner whenNotSealed {
        byInt[key] = value;
    }

    /// @notice Set one entry of `byBytes32`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setByBytes32(bytes32 key, uint256 value) external onlyOwner whenNotSealed {
        byBytes32[key] = value;
    }

    /// @notice Set one entry of `byString`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setByString(string calldata key, uint256 value) external onlyOwner whenNotSealed {
        byString[key] = value;
    }

    /// @notice Set one entry of `byBytes`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setByBytes(bytes calldata key, uint256 value) external onlyOwner whenNotSealed {
        byBytes[key] = value;
    }

    /// @notice Set one entry of `nested`.
    /// @param outer First key.
    /// @param inner Second key.
    /// @param value Value to store.
    function setNested(address outer, uint256 inner, uint256 value) external onlyOwner whenNotSealed {
        nested[outer][inner] = value;
    }

    /// @notice Set one entry of `deep`.
    /// @param outer First key.
    /// @param middle Second key.
    /// @param inner Third key.
    /// @param value Value to store.
    function setDeep(
        address outer,
        string calldata middle,
        uint256 inner,
        bool value
    ) external onlyOwner whenNotSealed {
        deep[outer][middle][inner] = value;
    }

    /// @notice Append to one list of `lists`.
    /// @param key Key of the list.
    /// @param value Value to append.
    function pushToList(uint256 key, uint256 value) external onlyOwner whenNotSealed {
        lists[key].push(value);
    }
}
