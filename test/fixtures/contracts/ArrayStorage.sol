// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ArrayStorage
/// @notice Fixture holding dynamic and fixed arrays of several element sizes.
/// @dev Exercises array layout: one element per slot, exact and gapped packing, packed fixed
/// arrays, multi-slot struct elements, nested dynamic arrays, and structs that solc rounds up
/// to a whole slot.
contract ArrayStorage {
    /// @notice A 64-byte struct used as an array element.
    /// @dev Spans two slots (left and right pack into the first, who takes the second).
    struct Pair {
        /// @dev Low half of the first slot.
        uint128 left;
        /// @dev High half of the first slot.
        uint128 right;
        /// @dev Alone in the second slot.
        address who;
    }

    // A struct whose FIELDS would pack into 2 bytes if solc treated it like a scalar. It does
    // not: solc always rounds a struct type's `numberOfBytes` up to a whole slot (verified
    // against solc 0.8.26's storageLayout output), so each element below gets its own whole
    // slot rather than several tiny structs sharing one — pinning that here catches any future
    // regression toward the "pack by raw byte count" bug this repo specifically ruled out.
    /// @notice A struct whose two uint8 fields would total 2 bytes if packed as a scalar.
    /// @dev solc rounds a struct's `numberOfBytes` up to a whole slot, so each array element
    /// still occupies its own slot.
    struct TinyPair {
        /// @dev First byte of the struct's slot.
        uint8 a;
        /// @dev Second byte of the struct's slot.
        uint8 b;
    }

    /// @notice Dynamic array of addresses.
    address[] public addresses; // 20 bytes -> 1 per slot
    /// @notice Dynamic array of uint128 values.
    uint128[] public exactPacked; // 16 bytes -> 2 per slot, no remainder
    /// @notice Dynamic array of uint96 values.
    uint96[] public gapPacked; // 12 bytes -> 2 per slot, 8-byte TRAILING GAP
    /// @notice Dynamic array of full-slot words.
    uint256[] public words; // 32 bytes -> 1 per slot
    /// @notice Fixed array of ten packed uint8 values.
    uint8[10] public fixedPacked; // packed fixed array; numberOfBytes is 32, length is 10
    /// @notice Fixed array of three full-slot words.
    uint256[3] public fixedWords; // one element per slot, in place
    /// @notice Dynamic array of two-slot `Pair` structs.
    Pair[] public pairs; // 64-byte element -> 2 slots each
    /// @notice Dynamic array of dynamic arrays.
    uint256[][] public nested; // outer element slot IS the inner array's header slot
    /// @notice Dynamic array of `TinyPair` structs.
    TinyPair[] public tinyPairs; // 2-byte-if-packed struct -> solc still gives each ONE slot

    /// @notice Append every given address to `addresses`.
    /// @param values Addresses to append.
    function pushAddresses(address[] calldata values) external {
        for (uint256 i = 0; i < values.length; i++) addresses.push(values[i]);
    }

    /// @notice Append every given value to `exactPacked`.
    /// @param values Values to append.
    function pushExactPacked(uint128[] calldata values) external {
        for (uint256 i = 0; i < values.length; i++) exactPacked.push(values[i]);
    }

    /// @notice Append every given value to `gapPacked`.
    /// @param values Values to append.
    function pushGapPacked(uint96[] calldata values) external {
        for (uint256 i = 0; i < values.length; i++) gapPacked.push(values[i]);
    }

    /// @notice Append every given word to `words`.
    /// @param values Words to append.
    function pushWords(uint256[] calldata values) external {
        for (uint256 i = 0; i < values.length; i++) words.push(values[i]);
    }

    /// @notice Set one element of `fixedPacked`.
    /// @param index Element index (reverts when out of range).
    /// @param value New element value.
    function setFixedPacked(uint256 index, uint8 value) external {
        fixedPacked[index] = value;
    }

    /// @notice Set one element of `fixedWords`.
    /// @param index Element index (reverts when out of range).
    /// @param value New element value.
    function setFixedWords(uint256 index, uint256 value) external {
        fixedWords[index] = value;
    }

    /// @notice Append a `Pair` to `pairs`.
    /// @param left Value for `Pair.left`.
    /// @param right Value for `Pair.right`.
    /// @param who Value for `Pair.who`.
    function pushPair(uint128 left, uint128 right, address who) external {
        pairs.push(Pair({left: left, right: right, who: who}));
    }

    /// @notice Append a `TinyPair` to `tinyPairs`.
    /// @param a Value for `TinyPair.a`.
    /// @param b Value for `TinyPair.b`.
    function pushTinyPair(uint8 a, uint8 b) external {
        tinyPairs.push(TinyPair({a: a, b: b}));
    }

    /// @notice Append one row to `nested`, so an outer element's slot becomes an inner header slot.
    /// @param row Elements of the new inner array.
    function pushNestedRow(uint256[] calldata row) external {
        nested.push();
        uint256[] storage inner = nested[nested.length - 1];
        for (uint256 i = 0; i < row.length; i++) inner.push(row[i]);
    }

    /// @notice Shrink `words` by removing elements from the end.
    /// @dev Used by the `.at(blockTag)` history tests, where a historical read must still see
    /// the OLD length rather than the latest one.
    /// @param howMany Number of elements to pop (reverts if `words` is shorter).
    function popWords(uint256 howMany) external {
        for (uint256 i = 0; i < howMany; i++) words.pop();
    }

    /// @notice Current length of `words`.
    /// @return The number of elements in `words`.
    function wordsLength() external view returns (uint256) {
        return words.length;
    }
}
