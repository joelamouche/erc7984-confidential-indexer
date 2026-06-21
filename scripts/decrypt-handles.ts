/**
 * Out-of-process decryption helper.
 *
 * The Zama SDK's node() transport bootstraps worker threads via
 * `import.meta.resolve`, which Ponder's Vite SSR runtime doesn't provide — so the
 * SDK can't be called from inside an indexing handler. The backfill spawns this in
 * plain Node (tsx), where the SDK works, and pipes a job in / cleartext out.
 *
 * stdin:  { contractAddress, groups: [{ delegator: address|null, handles: [hex] }] }
 * stdout: { groups: [{ values: { hex: "cleartext" } } | { errorName: "..." }] }
 */
import type { Address, Hex } from "viem";
import { delegatedDecrypt, holderDecrypt } from "../src/zama/sdk";

interface Group {
  delegator: Address | null;
  handles: Hex[];
}
interface Job {
  contractAddress: Address;
  groups: Group[];
}

/** Read the whole job JSON piped in on stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Decrypt each group via the SDK and write {values|errorName} per group to stdout. */
async function main() {
  const job: Job = JSON.parse(await readStdin());
  const out: { groups: Array<{ values?: Record<string, string>; errorName?: string }> } = { groups: [] };

  for (const group of job.groups) {
    try {
      const decrypted = group.delegator
        ? await delegatedDecrypt(group.handles, job.contractAddress, group.delegator)
        : await holderDecrypt(group.handles, job.contractAddress);
      const values: Record<string, string> = {};
      for (const handle of group.handles) {
        const cleartext = decrypted[handle];
        if (cleartext !== undefined) values[handle] = cleartext.toString();
      }
      out.groups.push({ values });
    } catch (err) {
      out.groups.push({ errorName: (err as { constructor?: { name?: string }; name?: string })?.constructor?.name ?? (err as Error)?.name ?? "Unknown" });
    }
  }

  process.stdout.write(JSON.stringify(out));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
