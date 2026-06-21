/**
 * Print the derived role accounts and their on-chain balances.
 *
 *   npm run accounts
 *
 * Fund the FUNDER address (index 0) from a Sepolia faucet, then `npm run fund`
 * fans gas out to the rest. The same mnemonic yields the same addresses in the
 * scripts, the seed data, and the tests.
 */
import { formatEther } from "viem";
import { allRoles, env } from "../src/config";
import { chain, publicClient } from "../src/chain";

/** Print every role address and its balance; flag if the funder is unfunded. */
async function main() {
  console.log(`\nChain: ${chain.name} (${env.CHAIN_ID})  RPC: ${env.SEPOLIA_RPC_URL}`);
  console.log(`Derivation: ${env.DERIVATION_PATH}/<index>\n`);

  const balances = await Promise.all(
    allRoles.map((role) => publicClient.getBalance({ address: role.address })),
  );

  const table = allRoles.map((role, i) => ({
    role: role.role,
    index: role.index,
    address: role.address,
    balanceETH: formatEther(balances[i]!),
  }));

  console.table(table);

  const funderBalance = balances[0]!;
  if (funderBalance === 0n) {
    console.log(
      `\n⚠️  Funder (${allRoles[0]!.address}) has 0 ETH. Fund it from a Sepolia faucet, then run \`npm run fund\`.`,
    );
  } else {
    console.log(`\n✅ Funder has ${formatEther(funderBalance)} ETH.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
