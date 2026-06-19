#!/usr/bin/env bash
# Reproducible install of the Foundry + fhEVM dependency set.
# Run from the contracts/ directory:  ./setup.sh
#
# The TS indexer/API do NOT need this — they run against deployed addresses and
# vendored ABIs. Run this only to rebuild/redeploy the contracts from source.
set -euo pipefail

# fhEVM Solidity lib + encrypted types come via npm (forge-fhevm pins 0.11.1).
npm install

# Pinned to the set that compiles together on solc 0.8.27 (the versions
# forge-fhevm and openzeppelin-confidential-contracts v0.4.0 themselves pin).
forge install --no-git foundry-rs/forge-std@v1.16.1
forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.1.0
forge install --no-git OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0
forge install --no-git OpenZeppelin/openzeppelin-confidential-contracts@v0.4.0
forge install --no-git zama-ai/forge-fhevm

forge build
echo "✅ contracts built. Run 'forge test -vv' or deploy with 'npm run deploy' from the repo root."
