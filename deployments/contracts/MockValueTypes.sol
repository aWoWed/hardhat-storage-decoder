// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title IMockToken
/// @notice Minimal interface, used only as a contract-typed storage value.
interface IMockToken {
    /// @notice Total token supply.
    /// @return The total supply.
    function totalSupply() external view returns (uint256);
}

/// @title MockValueTypes
/// @notice Sealed mock holding one variable of each elementary value type.
/// @dev `revision` is the value that changes across recorded blocks before sealing (AC 3): its
/// setter can be called any number of times until `seal()`.
contract MockValueTypes is Sealable {
    /// @notice Changes across recorded blocks, for `.at(block)` reads against real history.
    uint256 public revision;
    /// @notice Unsigned value.
    uint256 public unsignedValue;
    /// @notice Signed value.
    int256 public signedValue;
    /// @notice Boolean value.
    bool public flag;
    /// @notice Address value.
    address public account;
    /// @notice Fixed-size bytes taking a full slot.
    bytes32 public digest;
    /// @notice Fixed-size bytes narrower than a slot.
    bytes4 public selectorValue;
    /// @notice Contract-typed value, stored as an address.
    IMockToken public token;
    /// @dev External function value: 24 bytes.
    function() external callback;
    /// @dev Internal function value: 8 bytes.
    function(uint256) internal pure returns (uint256) op;

    /// @notice Set `revision`.
    /// @param value New value.
    function setRevision(uint256 value) external onlyOwner whenNotSealed {
        revision = value;
    }

    /// @notice Set the numeric and boolean values.
    /// @param unsignedValue_ New `unsignedValue`.
    /// @param signedValue_ New `signedValue`.
    /// @param flag_ New `flag`.
    function setNumbers(
        uint256 unsignedValue_,
        int256 signedValue_,
        bool flag_
    ) external onlyOwner whenNotSealed {
        unsignedValue = unsignedValue_;
        signedValue = signedValue_;
        flag = flag_;
    }

    /// @notice Set the address-like and fixed-bytes values.
    /// @param account_ New `account`.
    /// @param digest_ New `digest`.
    /// @param selector_ New `selectorValue`.
    /// @param token_ New `token`.
    function setReferences(
        address account_,
        bytes32 digest_,
        bytes4 selector_,
        IMockToken token_
    ) external onlyOwner whenNotSealed {
        account = account_;
        digest = digest_;
        selectorValue = selector_;
        token = token_;
    }

    /// @notice Point `callback` at this contract's `seal`. Only stored, never called.
    function setCallback() external onlyOwner whenNotSealed {
        callback = this.seal;
    }

    /// @notice Point `op` at one of two internal functions.
    /// @param useTriple True for `triple`, false for `double`.
    function setOp(bool useTriple) external onlyOwner whenNotSealed {
        op = useTriple ? triple : double;
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
