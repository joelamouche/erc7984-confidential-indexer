// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

import {ToyUSD} from "../src/ToyUSD.sol";
import {ConfidentialUSD} from "../src/ConfidentialUSD.sol";

contract ConfidentialUSDTest is FhevmTest {
    ToyUSD internal toy;
    ConfidentialUSD internal cusd;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    // ToyUSD has 6 decimals; the wrapper rate accounts for the 9 -> 6 gap, but
    // since cleartext amounts here are simple multiples of `rate()`, wrapping
    // `100 * rate()` underlying yields `100` confidential units. We compute the
    // expected confidential amount from the contract's own `rate()`.
    uint64 internal constant WRAP_UNITS = 100; // confidential units expected after wrap

    function setUp() public override {
        super.setUp();

        toy = new ToyUSD();
        cusd = new ConfidentialUSD(IERC20(address(toy)));
    }

    /// @notice Deployer mints ToyUSD to Alice, Alice approves + wraps (shields).
    ///         The resulting confidential balance must decrypt to WRAP_UNITS.
    function test_WrapShieldsBalance() public {
        uint256 rate = cusd.rate();
        uint256 underlyingAmount = uint256(WRAP_UNITS) * rate;

        // Deployer (this contract) mints cleartext ToyUSD to Alice.
        toy.mint(alice, underlyingAmount);
        assertEq(toy.balanceOf(alice), underlyingAmount);

        // Alice approves the wrapper and wraps her cleartext tokens.
        vm.startPrank(alice);
        toy.approve(address(cusd), underlyingAmount);
        cusd.wrap(alice, underlyingAmount);
        vm.stopPrank();

        // Cleartext tokens are now held by the wrapper contract.
        assertEq(toy.balanceOf(alice), 0);
        assertEq(toy.balanceOf(address(cusd)), underlyingAmount);

        // Confidential balance decrypts to the wrapped amount.
        euint64 encBal = cusd.confidentialBalanceOf(alice);
        assertEq(decrypt(encBal), WRAP_UNITS, "alice confidential balance after wrap");
    }

    /// @notice A confidentialTransfer from Alice to Bob moves confidential units;
    ///         assert both resulting balances.
    function test_ConfidentialTransfer() public {
        uint256 rate = cusd.rate();
        uint256 underlyingAmount = uint256(WRAP_UNITS) * rate;

        // Seed + wrap for Alice.
        toy.mint(alice, underlyingAmount);
        vm.startPrank(alice);
        toy.approve(address(cusd), underlyingAmount);
        cusd.wrap(alice, underlyingAmount);
        vm.stopPrank();

        assertEq(decrypt(cusd.confidentialBalanceOf(alice)), WRAP_UNITS);
        assertEq(decrypt(cusd.confidentialBalanceOf(bob)), 0);

        // Alice transfers 40 confidential units to Bob using an encrypted input.
        uint64 sendAmount = 40;
        (externalEuint64 encAmount, bytes memory proof) = encryptUint64(sendAmount, alice, address(cusd));

        vm.prank(alice);
        cusd.confidentialTransfer(bob, encAmount, proof);

        assertEq(decrypt(cusd.confidentialBalanceOf(alice)), WRAP_UNITS - sendAmount, "alice after transfer");
        assertEq(decrypt(cusd.confidentialBalanceOf(bob)), sendAmount, "bob after transfer");
    }

    // TODO unwrap: the two-phase unwrap (`unwrap` -> `UnwrapRequested`, then
    // off-chain KMS decryption -> `finalizeUnwrap` with a decryption proof) is
    // not exercised here. `finalizeUnwrap` calls `FHE.checkSignatures` against a
    // KMS-signed decryption proof; reproducing that proof flow under forge-fhevm
    // requires the public-decrypt / buildDecryptionProof path and is left as a
    // follow-up. The indexer can still observe `UnwrapRequested` / `UnwrapFinalized`
    // events emitted by the deployed contract.
    function test_Unwrap_TODO() public {
        // intentionally empty stub; see comment above.
    }
}
