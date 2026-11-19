import { existsSync, lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";

export interface Placement { department: string; reports_to?: string; title?: string }
export interface PlacementPaths { registry: string; org: string }

function document(path: string) {
  const doc = YAML.parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0]!.message}`);
  return doc;
}
function data(path: string): any { return document(path).toJS() ?? {}; }

/** The role and portable specialist share one existing-department placement rule. */
export function placementProblems(employee: string, placement: Partial<Placement>, paths: PlacementPaths, requireEmployee = true): string[] {
  const problems: string[] = [];
  if (!placement.department) return placement.reports_to || placement.title ? [`${employee}: placement requires department`] : [];
  const title = placement.title;
  if (title !== undefined && (!title.trim() || /[\u0000-\u001f\u007f]/u.test(title) || title.length > 160)) problems.push(`${employee}: title must be 1-160 printable characters`);
  const chart = data(paths.org), agents = data(paths.registry).agents ?? {};
  const departments = chart.departments;
  if (!Array.isArray(departments)) return [`${employee}: org departments must be a list`];
  const matches = departments.filter((d: any) => d?.id === placement.department);
  if (matches.length !== 1) return [`${employee}: department ${placement.department} ${matches.length ? "is duplicated" : "absent from org.yaml"}`];
  if (chart.personas !== undefined && (chart.personas === null || typeof chart.personas !== "object" || Array.isArray(chart.personas))) problems.push(`${employee}: org personas must be a mapping`);
  if (chart.personas?.[employee] !== undefined && (chart.personas[employee] === null || typeof chart.personas[employee] !== "object" || Array.isArray(chart.personas[employee]))) problems.push(`${employee}: org persona must be a mapping`);
  if (departments.some((d: any) => d?.manager === employee && d !== matches[0])) problems.push(`${employee}: manager of another department; appointment is not a placement edit`);
  const superior = placement.reports_to ?? matches[0].manager;
  if (!superior) problems.push(`${employee}: reports_to absent and department ${placement.department} has no manager`);
  else if (superior !== chart.ceo?.id && !Object.hasOwn(agents, superior)) problems.push(`${employee}: reports_to ${superior} absent from registry or org CEO`);
  if (requireEmployee && !Object.hasOwn(agents, employee)) problems.push(`${employee}: employee absent from registry`);
  const edges: Record<string, string | undefined> = Object.fromEntries(Object.entries(agents).map(([id, row]) => [id, (row as any)?.reports_to]));
  edges[employee] = superior;
  const seen = new Set<string>(); let cursor: string | undefined = employee;
  while (cursor && cursor !== chart.ceo?.id) {
    if (seen.has(cursor)) { problems.push(`${employee}: reporting cycle ${[...seen, cursor].join(" -> ")}`); break; }
    seen.add(cursor); cursor = edges[cursor];
  }
  return problems;
}
export function resolvedSuperior(placement: Placement, paths: PlacementPaths): string {
  const department = data(paths.org).departments.find((d: any) => d.id === placement.department);
  return placement.reports_to ?? department.manager;
}
/** Audit the registry AND the recorded org membership/title, not the inferred tree. */
export function placementDrift(employee: string, placement: Partial<Placement>, paths: PlacementPaths): string[] {
  const problems = placementProblems(employee, placement, paths, false);
  if (!placement.department || problems.length) return problems;
  const chart = data(paths.org), row = data(paths.registry).agents[employee];
  const dept = chart.departments.find((d: any) => d.id === placement.department);
  const actual = chart.departments.filter((d: any) => d.manager === employee || d.members?.includes(employee));
  if (actual.length !== 1 || actual[0] !== dept) problems.push(`${employee}: org membership differs from declaration ${placement.department}`);
  if (!row) problems.push(`${employee}: employee absent from registry`);
  if (row?.department !== placement.department) problems.push(`${employee}: registry department differs from declaration ${placement.department}`);
  const superior = resolvedSuperior(placement as Placement, paths);
  if (row?.reports_to !== superior) problems.push(`${employee}: registry reports_to differs from declaration ${superior}`);
  if (placement.title !== undefined && chart.personas?.[employee]?.title !== placement.title) problems.push(`${employee}: org persona title differs from declaration ${placement.title}`);
  return problems;
}
function update(path: string, edit: (doc: YAML.Document) => void, org = false): boolean {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    if (!org) throw new Error(`Refusing source symlink ${path}`);
    path = realpathSync(path);
    if (!lstatSync(path).isFile()) throw new Error(`Org symlink target must be a regular file: ${path}`);
  }
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const doc = YAML.parseDocument(before || "{}\n", { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  edit(doc);
  const after = String(doc);
  if (after === before) return false;
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, after); return true;
}
/** Caller holds the registry lock and has preflighted the declaration. */
export function projectPlacement(employee: string, placement: Placement, paths: PlacementPaths): boolean {
  const problems = placementProblems(employee, placement, paths, false);
  if (problems.length) throw new Error(problems.join("; "));
  const superior = resolvedSuperior(placement, paths);
  const recordChanged = update(paths.registry, doc => {
    doc.setIn(["agents", employee, "department"], placement.department);
    doc.setIn(["agents", employee, "reports_to"], superior);
  });
  const orgChanged = update(paths.org, doc => {
    const departments = doc.get("departments", true);
    if (!YAML.isSeq(departments)) throw new Error("org departments must be a list");
    for (const item of departments.items) {
      if (!YAML.isMap(item)) continue;
      const target = item.get("id") === placement.department;
      if (item.get("manager") === employee) {
        if (!target) throw new Error(`${employee}: manager of another department; appointment is not a placement edit`);
        continue;
      }
      let members = item.get("members", true);
      if (!YAML.isSeq(members)) { if (!target) continue; item.set("members", []); members = item.get("members", true); }
      if (YAML.isSeq(members)) {
        for (let i = members.items.length - 1; i >= 0; i--) if (String(members.items[i]) === employee && !target) members.delete(i);
        if (target && !members.items.some(x => String(x) === employee)) members.add(employee);
      }
    }
    if (placement.title !== undefined) doc.setIn(["personas", employee, "title"], placement.title);
  }, true);
  return recordChanged || orgChanged;
}
