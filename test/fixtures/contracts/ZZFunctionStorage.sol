// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A user-defined value type wrapping bytes4.
type Tag is bytes4; // RIGHT-padded as a mapping key, and narrower than a word

/// @title ZZFunctionStorage
/// @notice Fixture holding function-typed state variables next to ordinary ones, and a mapping
/// keyed by a user-defined value type narrower than 32 bytes.
/// @dev An external function value occupies 24 bytes (address, then selector) and an internal
/// one 8 bytes; the two below share slot 1. Named to sort after `ZRecursiveStorage.sol`, so
/// adding it does not shift the AST ids baked into the other contracts' type ids.
contract ZZFunctionStorage {
    /// @notice Ordinary variable declared before the function-typed ones.
    uint256 public head;
    /// @dev External function value: 24 bytes at offset 0 of slot 1.
    function() external callback;
    /// @dev Internal function value: 8 bytes at offset 24 of slot 1.
    function(uint256) internal pure returns (uint256) op;
    /// @notice Ordinary variable declared after the function-typed ones.
    uint8 public tail;
    /// @notice Number stored per `Tag` key.
    mapping(Tag => uint256) public byTag;

    /// @notice Set the two ordinary variables.
    /// @param head_ New value of `head`.
    /// @param tail_ New value of `tail`.
    function setPlain(uint256 head_, uint8 tail_) external {
        head = head_;
        tail = tail_;
    }

    /// @notice A function for `callback` to point at.
    function ping() external {}

    /// @notice Point `callback` at this contract's `ping`.
    function setCallback() external {
        callback = this.ping;
    }

    /// @notice The address and selector `callback` holds.
    /// @return target Address of the contract the function belongs to.
    /// @return selector Selector of the function.
    function callbackParts() external view returns (address target, bytes4 selector) {
        return (callback.address, callback.selector);
    }

    /// @notice Point `op` at one of two internal functions.
    /// @param useTriple True for `triple`, false for `double`.
    function setOp(bool useTriple) external {
        op = useTriple ? triple : double;
    }

    /// @notice Call the function `op` points at.
    /// @param value Argument to pass.
    /// @return The function's result.
    function applyOp(uint256 value) external view returns (uint256) {
        return op(value);
    }

    /// @notice The 8 bytes `op` occupies in storage.
    /// @return raw The stored bytes, as they sit in the slot.
    function opRaw() external view returns (bytes8 raw) {
        assembly {
            raw := shl(192, shr(mul(op.offset, 8), sload(op.slot)))
        }
    }

    /// @notice Set one entry of `byTag`.
    /// @param key Raw value wrapped as the `Tag` key.
    /// @param value Value to store.
    function setByTag(bytes4 key, uint256 value) external {
        byTag[Tag.wrap(key)] = value;
    }

    /// @dev Doubles its argument.
    function double(uint256 value) internal pure returns (uint256) {
        return value * 2;
    }

    /// @dev Triples its argument.
    function triple(uint256 value) internal pure returns (uint256) {
        return value * 3;
    }
}
