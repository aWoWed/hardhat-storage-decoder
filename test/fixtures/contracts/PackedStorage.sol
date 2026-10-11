// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PackedStorage
/// @notice Fixture holding value-type variables that share storage slots.
/// @dev Exercises slot packing: several small types per slot, a signed value (sign extension),
/// bytesN placement, and a slot filled exactly (address plus uint96).
contract PackedStorage {
    /// @notice First variable of slot 0.
    uint128 public a; // slot 0, offset 0
    /// @notice Second variable of slot 0.
    uint64 public b; // slot 0, offset 16
    /// @notice Third variable of slot 0.
    uint32 public c; // slot 0, offset 24
    /// @notice Fourth variable of slot 0.
    bool public d; // slot 0, offset 28
    /// @notice Fifth variable of slot 0.
    uint8 public e; // slot 0, offset 29

    /// @notice Signed variable at the start of slot 1.
    int128 public f; // slot 1, offset 0  (negative values exercise sign extension)
    /// @notice bytes4 variable sharing slot 1 with `f`.
    bytes4 public g; // slot 1, offset 16

    /// @notice Address at the start of slot 2.
    address public h; // slot 2, offset 0
    /// @notice uint96 filling the rest of slot 2.
    uint96 public i; // slot 2, offset 20 (fills the slot exactly)

    /// @notice Set every variable in slot 0.
    /// @param a_ New value for `a`.
    /// @param b_ New value for `b`.
    /// @param c_ New value for `c`.
    /// @param d_ New value for `d`.
    /// @param e_ New value for `e`.
    function setSlot0(uint128 a_, uint64 b_, uint32 c_, bool d_, uint8 e_) external {
        a = a_;
        b = b_;
        c = c_;
        d = d_;
        e = e_;
    }

    /// @notice Set every variable in slot 1.
    /// @param f_ New value for `f`.
    /// @param g_ New value for `g`.
    function setSlot1(int128 f_, bytes4 g_) external {
        f = f_;
        g = g_;
    }

    /// @notice Set every variable in slot 2.
    /// @param h_ New value for `h`.
    /// @param i_ New value for `i`.
    function setSlot2(address h_, uint96 i_) external {
        h = h_;
        i = i_;
    }
}
