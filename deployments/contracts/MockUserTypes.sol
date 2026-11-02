// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

// The three underlying families that pad differently as mapping keys.
/// @notice A user-defined value type wrapping bytes32.
type MockId is bytes32; // RIGHT-padded
/// @notice A user-defined value type wrapping int128.
type MockSigned is int128; // sign-extended, LEFT-padded
/// @notice A user-defined value type wrapping uint96.
type MockAmount is uint96; // zero-extended, LEFT-padded

/// @title MockUserTypes
/// @notice Sealed mock holding user-defined value types as variables and as mapping keys.
contract MockUserTypes is Sealable {
    /// @notice Variable of the bytes32-backed type.
    MockId public idValue;
    /// @notice Variable of the int128-backed type.
    MockSigned public signedValue;
    /// @notice Variable of the uint96-backed type.
    MockAmount public amountValue;
    /// @notice Number stored per `MockId` key.
    mapping(MockId => uint256) public byId;
    /// @notice Number stored per `MockSigned` key.
    mapping(MockSigned => uint256) public bySigned;
    /// @notice Number stored per `MockAmount` key.
    mapping(MockAmount => uint256) public byAmount;

    /// @notice Set all three variables.
    /// @param id New `idValue`.
    /// @param signedAmount New `signedValue`.
    /// @param amount New `amountValue`.
    function setValues(MockId id, MockSigned signedAmount, MockAmount amount) external onlyOwner whenNotSealed {
        idValue = id;
        signedValue = signedAmount;
        amountValue = amount;
    }

    /// @notice Set one entry of `byId`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setById(MockId key, uint256 value) external onlyOwner whenNotSealed {
        byId[key] = value;
    }

    /// @notice Set one entry of `bySigned`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setBySigned(MockSigned key, uint256 value) external onlyOwner whenNotSealed {
        bySigned[key] = value;
    }

    /// @notice Set one entry of `byAmount`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setByAmount(MockAmount key, uint256 value) external onlyOwner whenNotSealed {
        byAmount[key] = value;
    }
}
