// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC7984ERC20Wrapper, ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

// NOTE on Sepolia wiring:
// The task asks for `SepoliaConfig`. In the known-good dependency set used here
// (@fhevm/solidity 0.11.1, which is the version OpenZeppelin confidential
// contracts v0.4.0 and forge-fhevm both pin), the standalone `SepoliaConfig`
// contract no longer exists. It was unified into `ZamaEthereumConfig`, whose
// constructor calls `FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig())`.
// That helper dispatches on `block.chainid` and selects the *Sepolia* coprocessor
// / ACL / KMS addresses when chainid == 11155111 (and the local addresses under
// the forge-fhevm harness at chainid 31337). So inheriting `ZamaEthereumConfig`
// IS the correct, current equivalent of `SepoliaConfig` for this version: it
// wires the Sepolia fhEVM coprocessor when deployed to Sepolia.
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialUSD (cUSD)
/// @notice Concrete ERC-7984 confidential token that wraps the cleartext `ToyUSD`
///         ERC20 1:1 (rate-adjusted by decimals). Inherits OpenZeppelin's
///         `ERC7984ERC20Wrapper` (which itself inherits `ERC7984`), so it emits
///         `ConfidentialTransfer` and supports `confidentialTransfer`,
///         `confidentialBalanceOf`, and the wrapper's `wrap` / `unwrap` /
///         `finalizeUnwrap` flow (with `UnwrapRequested` / `UnwrapFinalized`).
///
///         Inherits `ZamaEthereumConfig` to wire the fhEVM coprocessor; on
///         Sepolia (chainid 11155111) this resolves to Sepolia's ACL / KMS /
///         Coprocessor addresses.
contract ConfidentialUSD is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    /// @param underlying The cleartext ERC20 to wrap (ToyUSD).
    /// @dev `ERC7984ERC20Wrapper(underlying)` sets the underlying token + rate;
    ///      `ERC7984(name, symbol, tokenURI)` sets the confidential token metadata.
    constructor(IERC20 underlying)
        ERC7984ERC20Wrapper(underlying)
        ERC7984("Confidential USD", "cUSD", "")
    {}
}
