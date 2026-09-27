import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import YAML from "yaml";
import { showPack } from "@delorenj/skillex";
import type {
  NamedAgentContract,
  ResolvedNamedAgentContract,
  ResolvedSkill,
  ValidationDiagnostic,
  ValidationOptions,
} from "./types.js";

export class NamedAgentValidationError extends Error {
  readonly diagnostics: ValidationDiagnostic[];

  constructor(message: string, diagnostics: ValidationDiagnostic[] = []) {
    super(message);
    this.name = "NamedAgentValidationError";
    this.diagnostics = diagnostics;
  }
}

const FALLBACK_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Portable Named Agent Contract",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "id",
    "display_name",
    "role",
    "charter",
    "skills",
    "memory",
  ],
  properties: {
    schema_version: { type: "integer", minimum: 1 },
    id: { type: "string", pattern: "^[a-z0-9]+([-_][a-z0-9]+)*$" },
    display_name: { type: "string", minLength: 1 },
    role: { type: "string", pattern: "^[a-z0-9]+([-_][a-z0-9]+)*$" },
    charter: {
      type: "object",
      additionalProperties: false,
      required: ["purpose"],
      properties: {
        purpose: { type: "string", minLength: 1 },
        directives: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        tone: { type: "string", minLength: 1 },
      },
    },
    skills: {
      type: "object",
      additionalProperties: false,
      required: ["pack"],
      properties: {
        pack: { type: "string", minLength: 1 },
      },
    },
    memory: {
      type: "object",
      additionalProperties: false,
      required: ["write_bank"],
      properties: {
        write_bank: { type: "string", pattern: "^agent-[a-z0-9-_]+$" },
        recall_banks: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    desk: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1 },
      },
    },
  },
};

function loadNamedAgentSchema(): object {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../../contracts/named-agent.schema.json"),
    resolve(here, "../../../contracts/named-agent.schema.json"),
    resolve(here, "../../contracts/named-agent.schema.json"),
    resolve(process.cwd(), "contracts/named-agent.schema.json"),
    resolve(process.cwd(), "flume/contracts/named-agent.schema.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, "utf8"));
      }
    } catch {
      // Continue to next candidate
    }
  }
  return FALLBACK_SCHEMA;
}

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    const AjvCtor = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    const schema = loadNamedAgentSchema();
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

/**
 * Parse a YAML or JSON string into an object.
 */
export function parseNamedAgentYaml(text: string): unknown {
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new NamedAgentValidationError(
      `Failed to parse named agent YAML: ${err instanceof Error ? err.message : String(err)}`,
      [{ message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}` }],
    );
  }
}

/**
 * Validate a named agent definition structurally against named-agent.schema.json.
 */
export function validateNamedAgentSchema(input: unknown): NamedAgentContract {
  let parsed = input;
  if (typeof parsed === "string") {
    parsed = parseNamedAgentYaml(parsed);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NamedAgentValidationError(
      "Named agent definition must be an object",
      [{ message: "Input is not an object" }],
    );
  }

  const validate = getValidator();
  const valid = validate(parsed);
  if (!valid && validate.errors) {
    const diagnostics: ValidationDiagnostic[] = validate.errors.map((err) => {
      let field = err.instancePath ? err.instancePath.replace(/^\//, "").replace(/\//g, ".") : undefined;
      let msg = err.message ?? "Validation failed";
      if (err.keyword === "required" && (err.params as { missingProperty?: string }).missingProperty) {
        const missing = (err.params as { missingProperty: string }).missingProperty;
        field = field ? `${field}.${missing}` : missing;
        msg = `Missing required field: ${field}`;
      } else if (err.keyword === "pattern") {
        msg = `Field "${field}" does not match pattern ${(err.params as { pattern: string }).pattern}`;
      } else if (err.keyword === "additionalProperties") {
        const extra = (err.params as { additionalProperty: string }).additionalProperty;
        field = extra;
        msg = `Additional property not allowed: ${extra}`;
      }
      return {
        field,
        message: msg,
        code: err.keyword,
      };
    });

    const summary = diagnostics.map((d) => d.message).join("; ");
    throw new NamedAgentValidationError(`Named agent schema validation failed: ${summary}`, diagnostics);
  }

  const contract = parsed as NamedAgentContract;

  // Additional semantic rule: memory.write_bank must start with "agent-"
  if (!contract.memory.write_bank.startsWith("agent-")) {
    throw new NamedAgentValidationError(
      `Invalid memory.write_bank "${contract.memory.write_bank}": must be explicitly configured as agent-<name>`,
      [{ field: "memory.write_bank", message: "Must start with agent-" }],
    );
  }

  return contract;
}

/**
 * Validate a named agent definition and resolve its Skillex pack and desk path.
 */
export async function validateNamedAgent(
  input: unknown,
  options: ValidationOptions = {},
): Promise<ResolvedNamedAgentContract> {
  const contract = validateNamedAgentSchema(input);

  // Resolve desk path: prioritize options.deskRoot when contract omits desk
  const deskPath = contract.desk?.path ?? (options.deskRoot ? join(options.deskRoot, contract.id) : `~/.agents/workforce/${contract.id}`);

  let resolvedSkills: ResolvedSkill[] = [];
  if (options.resolveSkills !== false) {
    const packResult = await showPack(contract.skills.pack, {
      registryRoot: options.skillexRoot,
      home: options.home,
    });

    if (!packResult.ok || !packResult.data?.pack) {
      const findings = packResult.findings ?? [];
      const missingSkill = findings.find((f) => f.code === "E_SKILL_MISSING");
      if (missingSkill) {
        throw new NamedAgentValidationError(
          `Agent pack "${contract.skills.pack}" references canonical skill that does not exist in Skillex catalog: ${missingSkill.message} (path: ${missingSkill.path})`,
          [
            {
              field: "skills.pack",
              code: "E_SKILL_MISSING",
              message: missingSkill.message,
              path: missingSkill.path,
            },
          ],
        );
      }
      const missingPack = findings.find((f) => f.code === "E_PACK_MISSING");
      if (missingPack) {
        throw new NamedAgentValidationError(
          `Agent pack "${contract.skills.pack}" not found: ${missingPack.message}`,
          [
            {
              field: "skills.pack",
              code: "E_PACK_MISSING",
              message: missingPack.message,
              path: missingPack.path,
            },
          ],
        );
      }
      const firstMsg = findings[0]?.message ?? `Pack "${contract.skills.pack}" could not be resolved`;
      throw new NamedAgentValidationError(
        `Agent pack "${contract.skills.pack}" resolution failed: ${firstMsg}`,
        findings.map((f) => ({
          field: "skills.pack",
          code: f.code,
          message: f.message,
          path: f.path,
        })),
      );
    }

    resolvedSkills = packResult.data.pack.skills.map((s) => ({
      name: s.name,
      path: s.path,
    }));

    // Verify each canonical target contains SKILL.md
    for (const skill of resolvedSkills) {
      const skillMd = join(skill.path, "SKILL.md");
      if (!existsSync(skillMd)) {
        throw new NamedAgentValidationError(
          `Canonical skill "${skill.name}" is missing SKILL.md at ${skill.path}`,
          [
            {
              field: "skills.pack",
              code: "E_SKILL_MISSING",
              message: `Canonical skill ${skill.name} missing SKILL.md`,
              path: skill.path,
            },
          ],
        );
      }
    }
  }

  return {
    ...contract,
    desk: { path: deskPath },
    resolvedSkills,
  };
}
