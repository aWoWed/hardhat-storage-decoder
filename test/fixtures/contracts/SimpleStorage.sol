// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title SimpleStorage
/// @notice Fixture holding one variable of each common value type.
/// @dev Exercises the baseline layout (each variable in order, packing where sizes allow) and
/// the constant/immutable case, which never appears in storageLayout.
contract SimpleStorage {
    /// @notice Unsigned counter.
    uint256 public count;
    /// @notice Signed counter.
    int256 public signedCount;
    /// @notice Boolean flag.
    bool public flag;
    /// @notice Stored address.
    address public owner;
    /// @notice Stored 32-byte digest.
    bytes32 public digest;
    /// @notice Stored 4-byte selector.
    bytes4 public selector;

    // Neither of these ever appears in storageLayout — they exist so the decoder can give a
    // precise "declared constant/immutable" error instead of implying a typo.
    /// @notice Compile-time constant, not stored in a slot.
    uint256 public constant MAX_COUNT = 1000;
    /// @notice Address that deployed the contract; set once in the constructor and not stored in a slot.
    address public immutable deployer;

    /// @notice Record the deployer.
    constructor() {
        deployer = msg.sender;
    }

    /// @notice Set every storage variable at once.
    /// @param count_ New value for `count`.
    /// @param signedCount_ New value for `signedCount`.
    /// @param flag_ New value for `flag`.
    /// @param owner_ New value for `owner`.
    /// @param digest_ New value for `digest`.
    /// @param selector_ New value for `selector`.
    function setAll(
        uint256 count_,
        int256 signedCount_,
        bool flag_,
        address owner_,
        bytes32 digest_,
        bytes4 selector_
    ) external {
        count = count_;
        signedCount = signedCount_;
        flag = flag_;
        owner = owner_;
        digest = digest_;
        selector = selector_;
    }

    /// @notice Set `count`.
    /// @param count_ New value.
    function setCount(uint256 count_) external {
        count = count_;
    }
}
