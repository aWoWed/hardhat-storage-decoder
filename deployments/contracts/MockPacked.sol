// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockPacked
/// @notice Sealed mock whose variables share slots at different offsets.
/// @dev Slot 0 holds `Sealable`'s `owner` and `isSealed`, then `small`, `medium`, `signedSmall` and
/// `enabled`. `holder` does not fit after them, so it starts slot 1, and `wide` does not fit after
/// `holder`, so it starts slot 2, with `tailA` and `tailB` packed behind it.
contract MockPacked is Sealable {
    /// @notice Offset 21 of slot 0.
    uint8 public small;
    /// @notice Offset 22 of slot 0.
    uint16 public medium;
    /// @notice Offset 24 of slot 0.
    int32 public signedSmall;
    /// @notice Offset 28 of slot 0.
    bool public enabled;
    /// @notice Offset 0 of slot 1.
    address public holder;
    /// @notice Offset 0 of slot 2.
    uint128 public wide;
    /// @notice Offset 16 of slot 2.
    uint64 public tailA;
    /// @notice Offset 24 of slot 2.
    bytes8 public tailB;

    /// @notice Set every variable of slot 1.
    /// @param small_ New `small`.
    /// @param medium_ New `medium`.
    /// @param signedSmall_ New `signedSmall`.
    /// @param enabled_ New `enabled`.
    /// @param holder_ New `holder`.
    function setFirstSlot(
        uint8 small_,
        uint16 medium_,
        int32 signedSmall_,
        bool enabled_,
        address holder_
    ) external onlyOwner whenNotSealed {
        small = small_;
        medium = medium_;
        signedSmall = signedSmall_;
        enabled = enabled_;
        holder = holder_;
    }

    /// @notice Set every variable of slot 2.
    /// @param wide_ New `wide`.
    /// @param tailA_ New `tailA`.
    /// @param tailB_ New `tailB`.
    function setSecondSlot(uint128 wide_, uint64 tailA_, bytes8 tailB_) external onlyOwner whenNotSealed {
        wide = wide_;
        tailA = tailA_;
        tailB = tailB_;
    }
}
