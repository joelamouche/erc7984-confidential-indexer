// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ToyUSD
/// @notice Minimal cleartext ERC20 used as the underlying asset for the
///         confidential wrapper. 6 decimals (USD-like). Public `mint` so the
///         deployer can seed test users on Sepolia.
contract ToyUSD is ERC20 {
    constructor() ERC20("Toy USD", "tUSD") {}

    /// @dev 6 decimals to match a typical USD stablecoin.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Public faucet-style mint for demo/testing only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
