// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Sealable} from "./Sealable.sol";

/// @title MockArrays
/// @notice Sealed mock holding dynamic and fixed arrays, packed and nested.
contract MockArrays is Sealable {
    /// @notice Dynamic array of full-slot elements.
    uint256[] public numbers;
    /// @notice Dynamic array whose elements pack into shared slots.
    uint8[] public smallNumbers;
    /// @notice Dynamic array of addresses.
    address[] public accounts;
    /// @notice Fixed array of full-slot elements.
    uint256[3] public fixedNumbers;
    /// @notice Fixed array whose elements pack into shared slots.
    uint16[5] public fixedSmall;
    /// @notice Fixed array of fixed arrays: 3 rows of 2.
    uint256[2][3] public matrix;
    /// @notice Dynamic array of dynamic arrays.
    uint256[][] public rows;

    /// @notice Append to `numbers`.
    /// @param value Value to append.
    function pushNumber(uint256 value) external onlyOwner whenNotSealed {
        numbers.push(value);
    }

    /// @notice Append to `smallNumbers`.
    /// @param value Value to append.
    function pushSmallNumber(uint8 value) external onlyOwner whenNotSealed {
        smallNumbers.push(value);
    }

    /// @notice Append to `accounts`.
    /// @param value Value to append.
    function pushAccount(address value) external onlyOwner whenNotSealed {
        accounts.push(value);
    }

    /// @notice Set one element of `fixedNumbers`.
    /// @param index Element to set.
    /// @param value Value to store.
    function setFixedNumber(uint256 index, uint256 value) external onlyOwner whenNotSealed {
        fixedNumbers[index] = value;
    }

    /// @notice Set one element of `fixedSmall`.
    /// @param index Element to set.
    /// @param value Value to store.
    function setFixedSmall(uint256 index, uint16 value) external onlyOwner whenNotSealed {
        fixedSmall[index] = value;
    }

    /// @notice Set one element of `matrix`.
    /// @param row Row, below 3.
    /// @param column Column, below 2.
    /// @param value Value to store.
    function setMatrix(uint256 row, uint256 column, uint256 value) external onlyOwner whenNotSealed {
        matrix[row][column] = value;
    }

    /// @notice Append one row to `rows`.
    /// @param row The row's values.
    function pushRow(uint256[] calldata row) external onlyOwner whenNotSealed {
        rows.push(row);
    }
}
