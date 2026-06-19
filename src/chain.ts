/** Shared viem chain + public client, derived from env. */
import { createPublicClient, defineChain, http } from "viem";
import { sepolia } from "viem/chains";
import { env } from "./config";

export const chain =
  env.CHAIN_ID === sepolia.id
    ? {
        ...sepolia,
        rpcUrls: { default: { http: [env.SEPOLIA_RPC_URL] } },
      }
    : defineChain({
        id: env.CHAIN_ID,
        name: `chain-${env.CHAIN_ID}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [env.SEPOLIA_RPC_URL] } },
      });

export const publicClient = createPublicClient({
  chain,
  transport: http(env.SEPOLIA_RPC_URL),
});
