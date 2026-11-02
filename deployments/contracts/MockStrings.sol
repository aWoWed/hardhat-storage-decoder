// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockStrings
/// @notice Sealed mock holding short and long strings and bytes.
/// @dev Solidity keeps 31 bytes or fewer inline in the header slot and anything longer in data
/// slots. A layout cannot show which applies, so the `short` and `long` names state the intent,
/// which `check-deployment-coverage.mjs` relies on and `sealable.test.ts` tests by setting
/// values and reading the header slot.
contract MockStrings is Sealable {
    /// @notice Holds at most 31 bytes, inline.
    string public shortText;
    /// @notice Holds more than 31 bytes, in data slots.
    string public longText;
    /// @notice Holds at most 31 bytes, inline.
    bytes public shortBlob;
    /// @notice Holds more than 31 bytes, in data slots.
    bytes public longBlob;

    /// @notice Set `shortText`.
    /// @param value New value.
    function setShortText(string calldata value) external onlyOwner whenNotSealed {
        shortText = value;
    }

    /// @notice Set `longText`.
    /// @param value New value.
    function setLongText(string calldata value) external onlyOwner whenNotSealed {
        longText = value;
    }

    /// @notice Set `shortBlob`.
    /// @param value New value.
    function setShortBlob(bytes calldata value) external onlyOwner whenNotSealed {
        shortBlob = value;
    }

    /// @notice Set `longBlob`.
    /// @param value New value.
    function setLongBlob(bytes calldata value) external onlyOwner whenNotSealed {
        longBlob = value;
    }
}
