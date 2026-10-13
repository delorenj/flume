// The one trusted-process secret read. It lives in its own module so the access
// facade, the GitHub adapter and the launcher can all use it without importing
// each other (launcher -> access -> github -> launcher would be a cycle).
import { spawnSync } from "node:child_process";

/** Resolve one secret with the vault CLI. The value is returned, never logged or put in an error. */
export function readVaultSecret(reference: string, label: string): string {
  const read = spawnSync("op", ["read", reference], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  if (read.error || read.status !== 0 || !read.stdout.trim()) throw new Error(`Deployment dependency: ${label} unavailable at ${reference}`);
  return read.stdout.trim();
}
