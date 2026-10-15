// The trusted launcher: the one place an employee's access is derived.
//
// The employee comes from enrolled configuration (the census), never from a
// prompt, env var or flag the child could set. The launcher resolves that
// employee's secrets with `op read` itself, mints a run assertion, strips the
// vault credential and every foreign bootstrap secret out of the child's
// environment, and hands over only this employee's access.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { importPKCS8 } from "jose";
import { loadAccessConfig, signRunAssertion } from "./access";
import { identityCensus, resolveEmployee } from "./company";
import { readTombstones, tombstoneFor } from "./lifecycle-state";
import { readVaultSecret } from "./vault";

/**
 * Env names that carry vault, Access, run or inference credentials, plus any inherited variable whose NAME looks like
 * a credential (the operator's own shell exports dozens), optionally followed by one `_<suffix>` (NOTION_API_KEY_RR),
 * and the operator's ssh-agent socket. None may reach a child unless re-added for that employee.
 * Suffix matches only: CLAUDE_CODE_MAX_CONTEXT_TOKENS and XAUTHORITY are not credentials.
 */
const SCRUBBED_PATTERNS = [
  /^OP_/u, /^CF_ACCESS_/u, /^FLUME_ACCESS_/u, /^FLUME_RUN_/u, /^AUTOMATICAI_GATEWAY_KEY$/u, /^SSH_AUTH_SOCK$/u,
  /^VAULT_/iu, /(TOKEN|SECRETS?|PASSWORD|PASSWD|PASSPHRASE|_PASS|API_?KEY|_KEY|CREDENTIALS?|_PAT|_DSN)(_[a-z0-9]+)?$/iu,
];
/** A value that embeds a password in a URL (`postgres://user:pass@host`) is a credential whatever its name. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:[^/@\s]+@/iu;
const INFERENCE_KEYS = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "HERMES_API_KEY", "HERMES_BASE_URL", "HERMES_MODEL", "LLM_MODEL", "HERMES_PROVIDER"];

/** The parent environment minus every credential, plus exactly `additions`. */
export function employeeChildEnv(parent: NodeJS.ProcessEnv, additions: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (SCRUBBED_PATTERNS.some(pattern => pattern.test(name)) || INFERENCE_KEYS.includes(name) || URL_WITH_PASSWORD.test(value ?? "")) continue;
    env[name] = value;
  }
  return { ...env, ...additions };
}

export { readVaultSecret };

export interface EmployeeAccess { subject: string; handle: string; runId: string; harness: string; env: Record<string, string> }

/**
 * Mint this employee's access for one run. Refuses an unenrolled, inactive or
 * unbound employee before any secret is read.
 */
export async function employeeAccessEnv(employee: string, harness: string): Promise<EmployeeAccess> {
  const target = resolveEmployee(identityCensus(), employee);
  if (target.problem) throw new Error(`Launch refused: definition for ${employee} is unreadable: ${target.problem}`);
  const block = target.block;
  if (!block) throw new Error(`Launch refused: ${employee} is not enrolled (flume identity enroll ${employee} --apply)`);
  if (block.status !== "active") throw new Error(`Launch refused: ${employee} is ${block.status}`);
  // A retired role.yaml reverted to active, or a hand-written block around a retired handle, is still retired. Tombstones
  // that cannot be read refuse the launch: no run assertion is minted on a guess.
  let retired: ReturnType<typeof tombstoneFor>;
  try { retired = tombstoneFor(readTombstones(), block); }
  catch (error) { throw new Error(`Launch refused: the retirement tombstones cannot be read (${(error as Error).message.split("\n")[0]})`); }
  if (retired) throw new Error(`Launch refused: ${employee} is retired (${retired.by} tombstone, ${retired.tombstone.retired_at})`);
  const binding = block.bindings?.cloudflare_access;
  if (!binding?.instance || !binding.credential_ref) throw new Error(`Launch refused: ${employee} has no cloudflare_access binding with an issuer instance and credential_ref`);
  const config = loadAccessConfig();
  if (binding.instance !== config.cloudflare_access.issuer) throw new Error(`Launch refused: ${employee}'s cloudflare_access issuer does not match the access configuration`);
  const secret = readVaultSecret(binding.credential_ref, "employee Access client secret");
  const signingKey = await importPKCS8(readVaultSecret(config.launcher.signing_key_ref, "launcher signing key"), "EdDSA");
  const runId = randomUUID();
  const assertion = await signRunAssertion(signingKey, { subject: block.subject, runId, harness });
  return {
    subject: block.subject, handle: block.handle, runId, harness,
    env: { FLUME_ACCESS_URL: config.url, CF_ACCESS_CLIENT_ID: binding.principal, CF_ACCESS_CLIENT_SECRET: secret, FLUME_RUN_ID: runId, FLUME_RUN_ASSERTION: assertion },
  };
}

/** `flume access run`: any plain command, as an enrolled employee, with only that employee's access. */
export async function runEmployeeCommand(employee: string, command: string[], cwd = process.cwd()): Promise<number> {
  if (!command.length) throw new Error("No command given");
  const access = await employeeAccessEnv(employee, "plain");
  const env = employeeChildEnv(process.env, access.env);
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: resolve(cwd), env, stdio: "inherit" });
    child.once("error", error => reject(new Error(`Cannot run ${command[0]}: ${error.message}`)));
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}
