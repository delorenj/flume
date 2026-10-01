import YAML from "yaml";

export type RoleIdentity =
  | { state: "none" }
  | { state: "named"; name: string; writeBank: string; recallBanks: string[] }
  | { state: "invalid"; reason: string };

const IDENTITY_NAME = /^[a-z0-9][a-z0-9_-]{0,57}$/u;
const IDENTITY_BANK = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const IDENTITY_KEYS = new Set(["name", "write_bank", "recall_banks"]);
const IDENTITY_RESERVED_BANKS = new Set(["custom", "hermes"]);
const IDENTITY_MAX_RECALL_BANKS = 16;

/** Established role.yaml semantics, shared by the role and Story 2.1 contracts. */
export function readRoleIdentity(text: string, agentId: string, profileName: string): RoleIdentity {
  let doc: ReturnType<typeof YAML.parseDocument>;
  try {
    doc = YAML.parseDocument(text, { uniqueKeys: true });
  } catch {
    return { state: "invalid", reason: "role.yaml is not valid YAML" };
  }
  if (doc.errors.length > 0) return { state: "invalid", reason: "role.yaml is not valid YAML" };
  const root = doc.toJS() as unknown;
  if (root === null || root === undefined) return { state: "none" };
  if (typeof root !== "object" || Array.isArray(root)) return { state: "invalid", reason: "role.yaml root must be a mapping" };
  const block = (root as Record<string, unknown>).identity;
  if (block === undefined || block === null) return { state: "none" };
  if (typeof block !== "object" || Array.isArray(block)) return { state: "invalid", reason: "identity must be a mapping with a `name`" };
  const fields = block as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !IDENTITY_KEYS.has(key)).sort();
  if (unknown.length) return { state: "invalid", reason: `identity carries unsupported key(s): ${unknown.join(", ")}` };
  const name = fields.name;
  if (typeof name !== "string" || !IDENTITY_NAME.test(name)) {
    return { state: "invalid", reason: "identity.name must be a lower-case id ([a-z0-9][a-z0-9_-]*, at most 58 chars)" };
  }
  if (name === agentId || name === profileName) {
    return { state: "invalid", reason: `identity.name "${name}" is a post id; a named agent needs a name of its own` };
  }
  const expected = `agent-${name}`;
  const writeBank = fields.write_bank === undefined ? expected : fields.write_bank;
  if (writeBank !== expected) return { state: "invalid", reason: `identity.write_bank must be "${expected}"` };
  const rawRecall = fields.recall_banks === undefined || fields.recall_banks === null ? [] : fields.recall_banks;
  if (!Array.isArray(rawRecall)) return { state: "invalid", reason: "identity.recall_banks must be a list of bank ids" };
  const recallBanks = [expected];
  for (const bank of rawRecall) {
    if (typeof bank !== "string" || !IDENTITY_BANK.test(bank)) {
      return { state: "invalid", reason: `identity.recall_banks entry ${JSON.stringify(bank)} is not a lower-case bank id` };
    }
    if (IDENTITY_RESERVED_BANKS.has(bank)) return { state: "invalid", reason: `identity.recall_banks may not name the shared fallback bank "${bank}"` };
    if (!recallBanks.includes(bank)) recallBanks.push(bank);
  }
  if (recallBanks.length > IDENTITY_MAX_RECALL_BANKS) {
    return { state: "invalid", reason: `identity.recall_banks names more than ${IDENTITY_MAX_RECALL_BANKS} banks` };
  }
  return { state: "named", name, writeBank: expected, recallBanks };
}
