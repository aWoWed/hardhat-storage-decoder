// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockShadowedBase
/// @notice Base contract whose private variables share names with the derived contract's.
/// @dev Solidity only forbids shadowing a VISIBLE state variable, so a private name can be
/// declared again further down the inheritance chain; both declarations occupy storage.
abstract contract MockShadowedBase is Sealable {
    /// @dev The base contract's own `shared` (private, so no getter).
    uint256 private shared;
    /// @dev Sits between the two `shared` variables, so their slots differ.
    uint256 internal between;
    /// @dev The base contract's own `table` (private).
    mapping(uint256 => uint256) private table;

    /// @notice Set the base contract's `shared`.
    /// @param value New value.
    function setBaseShared(uint256 value) external onlyOwner whenNotSealed {
        shared = value;
    }

    /// @notice Set `between`.
    /// @param value New value.
    function setBetween(uint256 value) external onlyOwner whenNotSealed {
        between = value;
    }

    /// @notice Set one entry of the base contract's `table`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setBaseTable(uint256 key, uint256 value) external onlyOwner whenNotSealed {
        table[key] = value;
    }
}

/// @title MockShadowed
/// @notice Sealed mock in which a derived contract reuses names its base already declares.
/// @dev The layout lists `shared` and `table` twice each; only the AST id tells them apart.
contract MockShadowed is MockShadowedBase {
    /// @dev The derived contract's own `shared` (private).
    uint256 private shared;
    /// @dev The derived contract's own `table` (private).
    mapping(uint256 => uint256) private table;

    /// @notice Set the derived contract's `shared`.
    /// @param value New value.
    function setDerivedShared(uint256 value) external onlyOwner whenNotSealed {
        shared = value;
    }

    /// @notice Set one entry of the derived contract's `table`.
    /// @param key Key to set.
    /// @param value Value to store.
    function setDerivedTable(uint256 key, uint256 value) external onlyOwner whenNotSealed {
        table[key] = value;
    }
}
