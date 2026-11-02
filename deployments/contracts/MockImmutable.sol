// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockImmutable
/// @notice Sealed mock with immutables, whose values sit in the deployed code, not in storage.
/// @dev Exercises the decoder's address check, which has to mask these bytes: two deployments
/// with different constructor arguments run the same code apart from them.
contract MockImmutable is Sealable {
    /// @notice Fixed at deployment.
    uint256 public immutable launchValue;
    /// @notice Fixed at deployment.
    address public immutable deployer;
    /// @notice An ordinary variable, to read through the address check.
    uint256 public stored;

    /// @param launchValue_ Value of `launchValue`.
    constructor(uint256 launchValue_) {
        launchValue = launchValue_;
        deployer = msg.sender;
    }

    /// @notice Set `stored`.
    /// @param value New value.
    function setStored(uint256 value) external onlyOwner whenNotSealed {
        stored = value;
    }
}
