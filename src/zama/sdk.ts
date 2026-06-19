/**
 * Zama SDK wiring — the indexer's decryption identity.
 *
 * One `ZamaSDK` configured with the *indexer holder* as signer (viem flavour, to
 * match Ponder). The holder signs EIP-712 permits locally (HD account, no RPC),
 * so decryption needs no user interaction. See docs/SDK-NOTES.md for the API.
 */
import { MemoryStorage, ZamaSDK, type FheChain } from "@zama-fhe/sdk";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { accounts, env } from "../config";
import { chain } from "../chain";

export const HOLDER: Address = accounts.indexerHolder.address;

let sdk: ZamaSDK | undefined;

export function getZamaSdk(): ZamaSDK {
  if (sdk) return sdk;
  // Decryption uses its own RPC (see DECRYPT_RPC_URL) so its bursty batched calls
  // don't fight the indexer's eth_getLogs load on a single throttled endpoint.
  const rpc = env.DECRYPT_RPC_URL ?? env.SEPOLIA_RPC_URL;
  const fheChain = { ...zamaSepolia, network: rpc } as FheChain;
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({
    account: accounts.indexerHolder.account,
    chain,
    transport: http(rpc),
  });
  sdk = new ZamaSDK(
    createConfig({
      chains: [fheChain],
      relayers: { [fheChain.id]: node() },
      storage: new MemoryStorage(),
      publicClient,
      walletClient,
    }),
  );
  return sdk;
}

/** Decrypt handles the holder is itself a party to. Returns handle -> cleartext. */
export async function holderDecrypt(
  handles: Hex[],
  contractAddress: Address,
): Promise<Record<Hex, bigint>> {
  const inputs = handles.map((h) => ({ encryptedValue: h, contractAddress }));
  return (await getZamaSdk().decryption.decryptValues(inputs)) as Record<Hex, bigint>;
}

/** Decrypt handles via an ACL delegation from `delegator` to the holder. */
export async function delegatedDecrypt(
  handles: Hex[],
  contractAddress: Address,
  delegator: Address,
): Promise<Record<Hex, bigint>> {
  const inputs = handles.map((h) => ({ encryptedValue: h, contractAddress }));
  return (await getZamaSdk().decryption.delegatedDecryptValues(inputs, delegator)) as Record<Hex, bigint>;
}
