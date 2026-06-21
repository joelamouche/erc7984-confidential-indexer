/** Load compiled Foundry artifacts (ABI + bytecode) from contracts/out. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";

/** Load a compiled contract's ABI + deploy bytecode from contracts/out. */
export function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(`contracts/out/${name}.sol/${name}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const bytecode = json.bytecode?.object as Hex | undefined;
  if (!bytecode || bytecode === "0x") {
    throw new Error(`No bytecode in ${path} — run contracts/setup.sh to build.`);
  }
  return { abi: json.abi as Abi, bytecode };
}

/** Load just the ABI of a compiled contract. */
export function loadAbi(name: string): Abi {
  return loadArtifact(name).abi;
}
