// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title BaseA
/// @notice Root of the inheritance chain, holding the first two variables.
/// @dev Its variables come first in the flattened layout; `basePacked` leaves trailing space
/// in slot 1 for a descendant to fill.
contract BaseA {
    /// @notice A full-slot base value.
    uint256 public baseValue; // slot 0
    /// @notice A 16-byte base value that leaves the rest of its slot free.
    uint128 public basePacked; // slot 1, offset 0

    /// @notice Set both base variables.
    /// @param baseValue_ New value for `baseValue`.
    /// @param basePacked_ New value for `basePacked`.
    function setBase(uint256 baseValue_, uint128 basePacked_) external {
        baseValue = baseValue_;
        basePacked = basePacked_;
    }
}

/// @title BaseB
/// @notice Middle contract of the inheritance chain.
/// @dev Its first variable packs into the parent's trailing space in slot 1.
contract BaseB is BaseA {
    /// @notice A 16-byte value sharing slot 1 with the parent's `basePacked`.
    uint128 public midPacked; // slot 1, offset 16 — packs into the PARENT's trailing space
    /// @notice An address stored in its own slot.
    address public midAddress; // slot 2

    /// @notice Set both middle variables.
    /// @param midPacked_ New value for `midPacked`.
    /// @param midAddress_ New value for `midAddress`.
    function setMid(uint128 midPacked_, address midAddress_) external {
        midPacked = midPacked_;
        midAddress = midAddress_;
    }
}

/// @title InheritedStorage
/// @notice Most-derived contract of the chain; the one whose layout is decoded.
/// @dev Exercises linearised inheritance order (BaseA, BaseB, then the child) and cross-contract
/// slot packing.
contract InheritedStorage is BaseB {
    /// @notice A full-slot child value.
    uint256 public childValue;
    /// @notice Number stored per address, declared by the child.
    mapping(address => uint256) public childMap;

    /// @notice Set `childValue`.
    /// @param childValue_ New value.
    function setChild(uint256 childValue_) external {
        childValue = childValue_;
    }

    /// @notice Set one entry of `childMap`.
    /// @param key Address used as the mapping key.
    /// @param value Value to store.
    function setChildMap(address key, uint256 value) external {
        childMap[key] = value;
    }
}
