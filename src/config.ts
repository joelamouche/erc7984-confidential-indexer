/**
 * Central env parsing + HD account derivation.
 *
 * Every actor (funder, deployer, indexer holder, test users) derives from one
 * MNEMONIC at fixed BIP-44 indices — see `.env.example` and DECISIONS.md §7.
 * We standardise on the viem stack (Ponder is viem-native, and the Zama SDK ships
 * a viem flavour) so there's a single chain/account model across indexer,
 * scripts, and tests.
 */
import "dotenv/config";
import { z } from "zod";
import { type Address, getAddress, isHex } from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

const addressSchema = z
  .string()
  .refine((v) => isHex(v) && v.length === 42, "must be a 0x-prefixed address")
  .transform((v) => getAddress(v));

/** Treats unset / "0x..." placeholder values as undefined (e.g. pre-deploy). */
const optionalAddress = z.preprocess(
  (v) => (typeof v === "string" && isHex(v) && v.length === 42 ? v : undefined),
  addressSchema.optional(),
);

const EnvSchema = z.object({
  // Accounts
  MNEMONIC: z.string().trim().min(1, "MNEMONIC is required"),
  DERIVATION_PATH: z.string().default("m/44'/60'/0'/0"),
  FUNDER_INDEX: z.coerce.number().int().nonnegative().default(0),
  DEPLOYER_INDEX: z.coerce.number().int().nonnegative().default(1),
  INDEXER_HOLDER_INDEX: z.coerce.number().int().nonnegative().default(2),
  TEST_USER_START_INDEX: z.coerce.number().int().nonnegative().default(3),
  TEST_USER_COUNT: z.coerce.number().int().nonnegative().default(4),

  // Funding amounts (ETH, as decimal strings -> parsed where used)
  FUND_DEPLOYER_ETH: z.string().default("0.1"),
  FUND_INDEXER_HOLDER_ETH: z.string().default("0.005"),
  FUND_TEST_USER_ETH: z.string().default("0.02"),

  // Chain / RPC
  SEPOLIA_RPC_URL: z.string().url(),
  // Separate RPC for the SDK decryption path (different workload than indexing:
  // bursty batched eth_calls vs. heavy eth_getLogs). Defaults to SEPOLIA_RPC_URL.
  DECRYPT_RPC_URL: z.string().url().optional(),
  CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  ETHERSCAN_API_KEY: z.string().default(""),

  // Contracts (token/wrapper filled in after deploy)
  TOKEN_ADDRESS: optionalAddress,
  WRAPPER_ADDRESS: optionalAddress,
  // Cleartext ERC20 underlying the wrapper (ToyUSD) — used by seed scripts, not indexed.
  UNDERLYING_USD_ADDRESS: optionalAddress,
  START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  ACL_ADDRESS: addressSchema.default("0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D"),

  // Zama SDK / relayer
  RELAYER_API_KEY: z.string().default(""),

  // Backfill worker
  BACKFILL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  DECRYPT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),

  // API
  PORT: z.coerce.number().int().positive().default(42069),
  MAX_LAG_SECONDS: z.coerce.number().int().positive().default(120),
  // Decryption-lag threshold for /v1/health `degraded`. Generous on purpose: a
  // legit history backfill transiently shows old block ages while draining in
  // ~seconds, so a tight value would false-positive. Default 10 min.
  MAX_DECRYPT_LAG_SECONDS: z.coerce.number().int().positive().default(600),
});

/** Validate process.env against the schema; throw a readable error if invalid. */
function parseEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment (.env):\n${issues}`);
  }
  return parsed.data;
}

export const env = parseEnv();

/** Derive the HD account at `<DERIVATION_PATH>/<index>` from the mnemonic. */
function deriveAccount(index: number): HDAccount {
  return mnemonicToAccount(env.MNEMONIC, {
    path: `${env.DERIVATION_PATH}/${index}` as `m/44'/60'/0'/0/${number}`,
  });
}

export type Role = "funder" | "deployer" | "indexerHolder" | `user${number}` | `subject${number}`;

export interface RoleAccount {
  role: Role;
  index: number;
  account: HDAccount;
  address: Address;
}

/** Bundle a role label with its derived account and address. */
function roleAccount(role: Role, index: number): RoleAccount {
  const account = deriveAccount(index);
  return { role, index, account, address: account.address };
}

export const accounts = {
  funder: roleAccount("funder", env.FUNDER_INDEX),
  deployer: roleAccount("deployer", env.DEPLOYER_INDEX),
  indexerHolder: roleAccount("indexerHolder", env.INDEXER_HOLDER_INDEX),
  testUsers: Array.from({ length: env.TEST_USER_COUNT }, (_, i) =>
    roleAccount(`user${i}`, env.TEST_USER_START_INDEX + i),
  ),
};

/** Flat list of all derived roles, in funding/printing order. */
export const allRoles: RoleAccount[] = [
  accounts.funder,
  accounts.deployer,
  accounts.indexerHolder,
  ...accounts.testUsers,
];

/**
 * A demo-subject account, derived *beyond* the configured test users (n ≥ 0). These
 * are the fresh, never-delegated subjects `demo:reset` provisions for the
 * "non-delegated user delegates → decrypts" beat (see docs/DEMO.md). Kept separate
 * from `testUsers` so the delegated cohort and the consumable subjects don't overlap.
 */
export function demoSubjectAccount(n: number): RoleAccount {
  const index = env.TEST_USER_START_INDEX + env.TEST_USER_COUNT + n;
  const account = deriveAccount(index);
  return { role: `subject${n}`, index, account, address: account.address };
}
