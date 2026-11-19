import { existsSync, lstatSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, renameSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { hireSpecialist, withSpecialistUpdate } from "./specialist";
import { validateNamedAgentSchema } from "./validator";
import { placementProblems, resolvedSuperior } from "./placement";

export interface PlaceOptions { department: string; reportsTo?: string; title?: string; apply?: boolean }
export async function placeSpecialist(employee: string, options: PlaceOptions) {
  if (!/^[a-z0-9][a-z0-9_-]{0,57}$/u.test(employee)) throw new Error("Unsafe employee identity");
  const home = process.env.HOME || homedir();
  const path = join(home, ".agents/workforce", employee, "agent.yaml");
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Owned specialist definition not found: ${path}`);
  const before = readFileSync(path, "utf8");
  const old = validateNamedAgentSchema(before);
  if (old.id !== employee) throw new Error("Definition identity mismatch");
  const placement = { department: options.department, reports_to: options.reportsTo, title: options.title ?? old.title };
  const paths = { registry: process.env.HERMES_AGENTS_REGISTRY || process.env.HERMES_FLEET_REGISTRY_FILE || join(process.env.HERMES_FLEET_HOME || join(home, ".hermes"), "agents-registry.yaml"), org: process.env.HERMES_ORG_PATH || join(process.env.HERMES_FLEET_HOME || join(home, ".hermes"), "org.yaml") };
  const problems = placementProblems(employee, placement, paths);
  if (problems.length) throw new Error(problems.join("; "));
  const doc = YAML.parseDocument(before, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  doc.set("department", placement.department);
  if (placement.reports_to !== undefined) doc.set("reports_to", placement.reports_to);
  else doc.delete("reports_to");
  if (placement.title !== undefined) doc.set("title", placement.title);
  const after = String(doc);
  const validated = validateNamedAgentSchema(after);
  if (validated.id !== employee) throw new Error("Definition identity changed");
  const from = { department: old.department ?? null, reports_to: old.reports_to ?? null, title: old.title ?? null };
  const to = { department: placement.department, reports_to: resolvedSuperior(placement, paths), title: placement.title ?? null };
  const scratchRoot = process.env.TMPDIR || join(home, ".hermes/cache/scratch");
  const preview = async (refresh?: (dry: boolean, candidate: string) => ReturnType<typeof hireSpecialist>) => {
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "flume-place-"));
    try {
      const candidate = join(scratch, "agent.yaml");
      writeFileSync(candidate, after, { mode: 0o600 });
      return await (refresh ? refresh(true, candidate) : hireSpecialist(candidate, true, { expectedEmployee: employee, dryRun: true }));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  };
  if (!options.apply) {
    const result = await preview();
    return { ok: true, apply: false, changed: before !== after, employee, from, to, projection: result.projection, writes: [] };
  }
  return withSpecialistUpdate(employee, async refresh => {
    if (readFileSync(path, "utf8") !== before) throw new Error("Definition changed while waiting for lock; retry");
    await preview(refresh);
    if (before !== after) {
      const temporary = join(dirname(path), `.agent-place-${randomUUID()}.tmp`);
      const recovery = join(dirname(path), `.agent-place-recovery-${randomUUID()}`);
      linkSync(path, recovery);
      try {
        writeFileSync(temporary, after, { mode: lstatSync(path).mode & 0o777, flag: "wx" });
        renameSync(temporary, path);
        if (validateNamedAgentSchema(readFileSync(path, "utf8")).id !== employee) throw new Error("Definition read-back failed");
      } catch (error) { renameSync(recovery, path); throw error; }
      finally { rmSync(temporary, { force: true }); rmSync(recovery, { force: true }); }
    }
    try {
      const result = await refresh();
      return { ok: true, apply: true, changed: before !== after || result.changed, employee, from, to, writes: before === after ? [] : [path], projection: result.projection };
    } catch (error) {
      throw new Error(`Definition retained; recover with flume onboard --employee ${employee}: ${(error as Error).message}`);
    }
  });
}
