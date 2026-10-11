// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// The three underlying families that pad differently as mapping keys.
/// @notice A user-defined value type wrapping bytes32.
type Id is bytes32; // RIGHT-padded
/// @notice A user-defined value type wrapping int128.
type Signed is int128; // sign-extended, LEFT-padded
/// @notice A user-defined value type wrapping uint96.
type Amount is uint96; // zero-extended, LEFT-padded

/// @title UserDefinedTypes
/// @notice Fixture holding user-defined value types as variables and as mapping keys.
/// @dev Exercises resolution of each wrapped type to its underlying storage and key-padding
/// rule: bytes32 (right-padded), int128 (sign-extended) and uint96 (zero-extended).
contract UserDefinedTypes {
    /// @notice Variable of the bytes32-backed type.
    Id public idVar;
    /// @notice Variable of the int128-backed type.
    Signed public signedVar;
    /// @notice Variable of the uint96-backed type.
    Amount public amountVar;

    /// @notice Number stored per `Id` key.
    mapping(Id => uint256) public byId;
    /// @notice Number stored per `Signed` key.
    mapping(Signed => uint256) public bySigned;
    /// @notice Number stored per `Amount` key.
    mapping(Amount => uint256) public byAmount;

    /// @notice Set all three variables from their raw underlying values.
    /// @param id_ Raw value to wrap as `Id`.
    /// @param signed_ Raw value to wrap as `Signed`.
    /// @param amount_ Raw value to wrap as `Amount`.
    function setVars(bytes32 id_, int128 signed_, uint96 amount_) external {
        idVar = Id.wrap(id_);
        signedVar = Signed.wrap(signed_);
        amountVar = Amount.wrap(amount_);
    }

    /// @notice Set one entry of `byId`.
    /// @param key Raw value wrapped as the `Id` key.
    /// @param value Value to store.
    function setById(bytes32 key, uint256 value) external {
        byId[Id.wrap(key)] = value;
    }

    /// @notice Set one entry of `bySigned`.
    /// @param key Raw value wrapped as the `Signed` key.
    /// @param value Value to store.
    function setBySigned(int128 key, uint256 value) external {
        bySigned[Signed.wrap(key)] = value;
    }

    /// @notice Set one entry of `byAmount`.
    /// @param key Raw value wrapped as the `Amount` key.
    /// @param value Value to store.
    function setByAmount(uint96 key, uint256 value) external {
        byAmount[Amount.wrap(key)] = value;
    }
}
