import { existsSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { showPack, showSet } from "@delorenj/skillex";
import namedSchema from "../../../../contracts/named-agent.schema.json";
import roleSchema from "../../../../contracts/role.schema.json";
import companyIdentitySchema from "../../../../contracts/company-identity.schema.json";
import employeeAccessSchema from "../../../../contracts/employee-access.schema.json";
import identityProvisioningSchema from "../../../../contracts/identity-provisioning.schema.json";
import { readRoleIdentity } from "./identity";
import type { AgentSkillsBinding, CompanyIdentity, NamedAgentContract, ResolvedNamedAgentContract, ResolvedSkill, ValidationDiagnostic, ValidationOptions } from "./types.js";

export class NamedAgentValidationError extends Error {
  constructor(message: string, readonly diagnostics: ValidationDiagnostic[] = []) {
    super(message); this.name = "NamedAgentValidationError";
  }
}
const AjvCtor = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;
const ajv = new AjvCtor({ allErrors: true, strict: false });
ajv.addSchema(companyIdentitySchema);
ajv.addSchema(employeeAccessSchema);
ajv.addSchema(identityProvisioningSchema);
ajv.addSchema(namedSchema);
const validateNamed = ajv.getSchema(namedSchema.$id)!;
const validateRole = ajv.compile(roleSchema);
const validateCompany = ajv.getSchema(companyIdentitySchema.$id)!;
const validateAccessRequestSchema = ajv.getSchema(`${employeeAccessSchema.$id}#/$defs/request`)!;
const validateMailRequestSchema = ajv.getSchema(`${employeeAccessSchema.$id}#/$defs/mail_request`)!;
const validateAccessConfigSchema = ajv.getSchema(`${employeeAccessSchema.$id}#/$defs/config`)!;
const validateProvisioningConfigSchema = ajv.getSchema(identityProvisioningSchema.$id)!;

/** Field-and-keyword diagnostics only: never the offending value, which may be hostile input. */
function schemaProblems(validate: { errors?: Array<{ instancePath: string; keyword: string; message?: string; params: Record<string, unknown> }> | null }): string[] {
  return (validate.errors ?? []).map(err => {
    const extra = err.keyword === "additionalProperties" ? ` (${String(err.params.additionalProperty)})` : "";
    return `${err.instancePath.replace(/^\//u, "").replace(/\//gu, ".") || "(request)"}: ${err.message ?? err.keyword}${extra}`;
  });
}
/** Problems with an access request body, or an empty list. */
export function accessRequestProblems(input: unknown): string[] {
  return validateAccessRequestSchema(input) ? [] : schemaProblems(validateAccessRequestSchema);
}
/** Problems with a FLUME-53 mail-authorize body: closed `{operation: list|read, message_id?}`, or an empty list. */
export function mailRequestProblems(input: unknown): string[] {
  return validateMailRequestSchema(input) ? [] : schemaProblems(validateMailRequestSchema);
}
/** Problems with the operator-authored access configuration, or an empty list. */
export function accessConfigProblems(input: unknown): string[] {
  return validateAccessConfigSchema(input) ? [] : schemaProblems(validateAccessConfigSchema);
}
/** Problems with the operator-authored provisioning configuration, or an empty list. */
export function provisioningConfigProblems(input: unknown): string[] {
  return validateProvisioningConfigSchema(input) ? [] : schemaProblems(validateProvisioningConfigSchema);
}

/** The company mail subdomain every personal address lives under. */
export const COMPANY_MAIL_DOMAIN = "agents.delo.sh";
/** RFC 2142 mailbox names: never a person's handle. */
export const RESERVED_HANDLES = new Set(["abuse", "ftp", "hostmaster", "info", "marketing", "news", "noc", "postmaster", "sales", "security", "support", "usenet", "uucp", "webmaster", "www"]);

/** Per-provider shape of `native_actor_id`: a GitHub bot user ID is digits, a Plane user ID a lowercase UUID. */
const ACTOR_SHAPES: Record<string, RegExp> = {
  github: /^\d+$/u,
  plane: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
};

export function parseNamedAgentYaml(text: string): unknown {
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new NamedAgentValidationError(`Failed to parse named agent YAML: ${doc.errors[0]!.message}`);
  return doc.toJS();
}
function structural(input: unknown, validate: typeof validateNamed): Record<string, any> {
  const parsed = typeof input === "string" ? parseNamedAgentYaml(input) : input;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new NamedAgentValidationError("Definition must be an object");
  if (!validate(parsed)) {
    const diagnostics = (validate.errors ?? []).map(err => {
      let field = err.instancePath.replace(/^\//u, "").replace(/\//gu, ".");
      let message = err.message ?? "Validation failed";
      if (err.keyword === "required") {
        field = [field, err.params.missingProperty].filter(Boolean).join(".");
        message = `Missing required field: ${field}`;
      } else if (err.keyword === "pattern") message = `Field "${field}" does not match pattern ${err.params.pattern}`;
      else if (err.keyword === "additionalProperties") message = `Additional property not allowed: ${err.params.additionalProperty}`;
      return {field, message, code: err.keyword};
    });
    throw new NamedAgentValidationError(`Schema validation failed: ${diagnostics.map(d => d.message).join("; ")}`, diagnostics);
  }
  return parsed as Record<string, any>;
}
function semanticIdentity(identity: unknown, post: string, profile: string): void {
  const result = readRoleIdentity(YAML.stringify({identity}), post, profile);
  if (result.state === "invalid") throw new NamedAgentValidationError(result.reason);
}
export function validateNamedAgentSchema(input: unknown): NamedAgentContract {
  const contract = structural(input, validateNamed) as NamedAgentContract;
  if (contract.identity && contract.identity.name !== contract.id) throw new NamedAgentValidationError("identity.name must equal id");
  semanticIdentity({name: contract.id, ...contract.memory}, "", "");
  if (contract.identity) semanticIdentity(contract.identity, "", "");
  if (contract.company_identity) validateCompanyIdentity(contract.company_identity);
  return contract;
}
/** A company_identity block, structurally and semantically, wherever it is declared. */
export function validateCompanyIdentity(input: unknown): CompanyIdentity {
  const block = structural(input, validateCompany) as CompanyIdentity;
  if (block.email !== `${block.handle}@${COMPANY_MAIL_DOMAIN}`) throw new NamedAgentValidationError(`company_identity.email must be ${block.handle}@${COMPANY_MAIL_DOMAIN}`);
  if (RESERVED_HANDLES.has(block.handle)) throw new NamedAgentValidationError(`company_identity.handle "${block.handle}" is an RFC 2142 role mailbox`);
  // The schema admits either shape; the provider decides which one is valid (FLUME-52).
  for (const [provider, binding] of Object.entries(block.bindings ?? {})) {
    if (binding.native_actor_id === undefined) continue;
    const shape = ACTOR_SHAPES[provider];
    if (shape && !shape.test(binding.native_actor_id)) throw new NamedAgentValidationError(`company_identity.bindings.${provider}.native_actor_id does not match the ${provider} actor ID format`);
  }
  return block;
}
export interface RoleDeclaration {
  role: string;
  skills?: AgentSkillsBinding;
  identity?: {name: string; write_bank?: string; recall_banks?: string[]};
  memory?: NamedAgentContract["memory"];
  department?: string;
  reports_to?: string;
  chain?: string[];
  [key: string]: unknown;
}
export function validateRoleDeclaration(input: unknown, post = "", profile = post): RoleDeclaration {
  const role = structural(input, validateRole) as RoleDeclaration;
  if (role.memory && !role.identity) throw new NamedAgentValidationError("memory requires identity.name");
  if (role.identity) {
    semanticIdentity(role.identity, post, profile);
    if (role.memory) {
      semanticIdentity({name: role.identity.name, ...role.memory}, post, profile);
      if (role.identity.write_bank && role.identity.write_bank !== role.memory.write_bank) throw new NamedAgentValidationError("identity and memory disagree");
    }
  }
  return role;
}
/** Resolve pack(s)/set through Skillex; both contract consumers use this loadout. */
export async function resolveSkillLoadout(binding: AgentSkillsBinding, options: ValidationOptions = {}): Promise<ResolvedSkill[]> {
  const skills = new Map<string, ResolvedSkill>();
  const packs = [...(binding.pack ? [binding.pack] : []), ...(binding.packs ?? [])];
  for (const [kind, ref] of [...packs.map(ref => ["pack", ref]), ...(binding.set ? [["set", binding.set]] : [])] as [string,string][]) {
    const opts = {registryRoot: options.skillexRoot, home: options.home};
    const result = kind === "pack" ? await showPack(ref, opts) : await showSet(ref, opts);
    const composition = result.data && ("pack" in result.data ? result.data.pack : result.data.set);
    if (!result.ok || !composition) {
      const findings = result.findings ?? [];
      const missing = findings.some(f => f.code === "E_SKILL_MISSING") ? " references canonical skill that does not exist in Skillex catalog" : " resolution failed";
      throw new NamedAgentValidationError(`Agent ${kind} "${ref}"${missing}: ${findings.map(f => `${f.message} (path: ${f.path})`).join("; ")}`, findings.map(f => ({...f, field: `skills.${kind}`})));
    }
    for (const skill of composition.skills) {
      if (!existsSync(join(skill.path, "SKILL.md"))) throw new NamedAgentValidationError(`Canonical skill "${skill.name}" is missing SKILL.md at ${skill.path}`);
      skills.set(skill.name, {name: skill.name, path: skill.path});
    }
  }
  return [...skills.values()].sort((a,b) => a.name.localeCompare(b.name));
}
export async function validateNamedAgent(input: unknown, options: ValidationOptions = {}): Promise<ResolvedNamedAgentContract> {
  const contract = validateNamedAgentSchema(input);
  return {...contract, desk: {path: contract.desk?.path ?? (options.deskRoot ? join(options.deskRoot, contract.id) : `~/.agents/workforce/${contract.id}`)},
    resolvedSkills: options.resolveSkills === false ? [] : await resolveSkillLoadout(contract.skills, options)};
}
