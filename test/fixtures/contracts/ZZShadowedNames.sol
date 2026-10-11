// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ZZShadowedBase
/// @notice Base contract whose private variables share names with the derived contract's.
/// @dev Solidity only forbids shadowing a VISIBLE state variable, so a private name can be
/// declared again further down the inheritance chain; both declarations occupy storage.
contract ZZShadowedBase {
    /// @dev The base contract's own `x` (private, so no getter).
    uint256 private x;
    /// @dev Declared once; sits between the two `x` variables so their slots differ.
    uint256 internal between;
    /// @dev The base contract's own `packed` (private); narrower than a slot.
    uint64 private packed;
    /// @dev The base contract's own `table` (private).
    mapping(uint256 => uint256) private table;
    /// @dev The base contract's own `list` (private).
    uint256[] private list;

    /// @notice Set one entry of the base contract's `table`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setBaseTable(uint256 key, uint256 value) external {
        table[key] = value;
    }

    /// @notice Append a value to the base contract's `list`.
    /// @param value Value to append.
    function pushBaseList(uint256 value) external {
        list.push(value);
    }

    /// @notice Set the base contract's `x`.
    /// @param value Value to store.
    function setBaseX(uint256 value) external {
        x = value;
    }

    /// @notice Read the base contract's `x`.
    /// @return The stored value.
    function baseX() external view returns (uint256) {
        return x;
    }

    /// @notice Set `between`.
    /// @param value Value to store.
    function setBetween(uint256 value) external {
        between = value;
    }

    /// @notice Set the base contract's `packed`.
    /// @param value Value to store.
    function setBasePacked(uint64 value) external {
        packed = value;
    }

    /// @notice Read the base contract's `packed`.
    /// @return The stored value.
    function basePacked() external view returns (uint64) {
        return packed;
    }
}

/// @title ZZShadowedNames
/// @notice Fixture in which a derived contract declares private variables under names its base
/// already uses.
/// @dev The storage layout lists `x`, `packed`, `table` and `list` twice each; only the AST id
/// tells the two declarations apart. Named to sort after `ZRecursiveStorage.sol`, so adding it
/// does not shift the AST ids baked into the other contracts' type ids.
contract ZZShadowedNames is ZZShadowedBase {
    /// @dev The derived contract's own `x` (private, so no getter).
    uint256 private x;
    /// @dev The derived contract's own `packed` (private).
    uint64 private packed;
    /// @dev The derived contract's own `table` (private).
    mapping(uint256 => uint256) private table;
    /// @dev The derived contract's own `list` (private).
    uint256[] private list;

    /// @notice Set one entry of the derived contract's `table`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setDerivedTable(uint256 key, uint256 value) external {
        table[key] = value;
    }

    /// @notice Append a value to the derived contract's `list`.
    /// @param value Value to append.
    function pushDerivedList(uint256 value) external {
        list.push(value);
    }

    /// @notice Set the derived contract's `x`.
    /// @param value Value to store.
    function setDerivedX(uint256 value) external {
        x = value;
    }

    /// @notice Read the derived contract's `x`.
    /// @return The stored value.
    function derivedX() external view returns (uint256) {
        return x;
    }

    /// @notice Set the derived contract's `packed`.
    /// @param value Value to store.
    function setDerivedPacked(uint64 value) external {
        packed = value;
    }

    /// @notice Read the derived contract's `packed`.
    /// @return The stored value.
    function derivedPacked() external view returns (uint64) {
        return packed;
    }
}
