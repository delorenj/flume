#!/usr/bin/env node
// `flume identity voice`: show, assign, clone+assign and clear the voice an employee speaks, against a constructed fleet
// home, a fake Vox server and a fake `voxxy` CLI. Never touches the live fleet, Vox or the gateway.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) { console.error("SKIP identity-voice-regressions: dist/ is not built (npm run build)"); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), "flume-voice-"));
const HOME = join(work, "home");
const FLEET = join(HOME, ".hermes");
const REG = join(FLEET, "agents-registry.yaml");
const REPOS = join(work, "repos");
const BIN = join(work, "bin");
const CLONELOG = join(work, "clone.log");
for (const dir of [HOME, FLEET, REPOS, BIN]) mkdirSync(dir, { recursive: true });

const ADDED = join(work, "added-voices");
// ---- fake Vox: GET /voices/<name> -----------------------------------------------------------------
const voices = new Set(["kurzgesagt", "brule", "walken"]);
const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "").replace(/^\/voices\//u, ""));
  if (existsSync(ADDED)) for (const v of readFileSync(ADDED, "utf8").split("\n").filter(Boolean)) voices.add(v);
  if (voices.has(name)) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name })); }
  else { res.writeHead(404); res.end("{}"); }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const VOX = `http://127.0.0.1:${server.address().port}`;

// ---- fake voxxy: `voice clone <who> --name <slug> ...` registers the slug (via a file the server polls) ----
writeFileSync(join(BIN, "voxxy"), `#!/bin/sh\necho "$@" >> ${CLONELOG}\nfor a in "$@"; do if [ "$prev" = "--name" ]; then echo "$a" >> ${ADDED}; fi; prev="$a"; done\n[ -n "$VOXXY_FAKE_EXIT" ] && exit "$VOXXY_FAKE_EXIT"\nexit 0\n`);
chmodSync(join(BIN, "voxxy"), 0o755);

// ---- the fleet ------------------------------------------------------------------------------------
const BASE = { model: { default: "fleet-model" }, tts: { provider: "vox", voice: "kurzgesagt", vox: { voice: "kurzgesagt", base_url: VOX } } };
writeFileSync(join(FLEET, "config.yaml"), YAML.stringify(BASE));
const agents = {};
for (const [id, person] of [["rhea-pm", "rhea"], ["ivy-pm", "ivy"]]) {
  agents[id] = { repo: id.replace(/-pm$/u, ""), role: "pm", type: "hermes", display_name: `${id} display`, profile_name: id, project_path: join(REPOS, id), role_dir: join(REPOS, id, "agents/hermes/pm") };
  const roleDir = join(REPOS, id, "agents/hermes/pm");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), `repo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n    - agent-${person}\n`);
  const desk = join(FLEET, "profiles", id);
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "config.delta.yaml"), `# keep me: an operator comment\n${YAML.stringify({ skills: { project_discovery: true } })}`, { mode: 0o600 });
  writeFileSync(join(desk, "config.yaml"), `# GENERATED FILE\n${YAML.stringify(BASE)}`, { mode: 0o600 });
}
writeFileSync(REG, YAML.stringify({ schema_version: 1, agents }), { mode: 0o600 });
writeFileSync(join(FLEET, "org.yaml"), "version: 1\ncompany: {name: Fixture Co., handle: Fix}\nceo: {id: ceo, display_name: Boss, title: CEO}\n");

const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
function flume(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, "identity", "voice", ...args, "--json"], {
      cwd: work,
      env: {
        PATH: `${BIN}:${dirname(python)}:/usr/bin:/bin`, HOME, NO_COLOR: "1", TMPDIR: "/tmp",
        HERMES_FLEET_HOME: FLEET, HERMES_AGENTS_REGISTRY: REG, HERMES_FLEET_REGISTRY_FILE: REG,
        HERMES_TEMPLATE_CONFIG: join(work, "no-config"), XDG_STATE_HOME: join(HOME, ".local/state"),
        FLUME_IDENTITY_STATE: join(work, "identity-state"), PYTHONDONTWRITEBYTECODE: "1", ...env,
      },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => {
      let body;
      try { body = JSON.parse(stdout); } catch { body = { parse_error: stdout, stderr }; }
      done({ status, body, stderr });
    });
  });
}
const delta = (id) => YAML.parse(readFileSync(join(FLEET, "profiles", id, "config.delta.yaml"), "utf8"));
const generated = (id) => YAML.parse(readFileSync(join(FLEET, "profiles", id, "config.yaml"), "utf8"));

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL ${name}\n  ${error.stack ?? error}`); }
}

await check("show: an unpinned desk speaks the fleet default", async () => {
  const { status, body } = await flume(["rhea-pm"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.deepEqual(body.speaks, { voice: "kurzgesagt", provider: "vox", source: "fleet default" });
  assert.equal(body.fleet_default, "kurzgesagt");
});

await check("assign previews by default and writes nothing", async () => {
  const before = readFileSync(join(FLEET, "profiles/rhea-pm/config.delta.yaml"), "utf8");
  const { status, body } = await flume(["rhea-pm", "--assign", "brule"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(body.changed, true);
  assert.deepEqual(body.writes, []);
  assert.equal(readFileSync(join(FLEET, "profiles/rhea-pm/config.delta.yaml"), "utf8"), before);
});

await check("assign --apply pins both leaves; the rendered desk speaks it; comments survive", async () => {
  const { status, body } = await flume(["rhea-pm", "--assign", "brule", "--apply"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(delta("rhea-pm").tts.voice, "brule");
  assert.equal(delta("rhea-pm").tts.vox.voice, "brule");
  assert.equal(generated("rhea-pm").tts.voice, "brule");
  assert.match(readFileSync(join(FLEET, "profiles/rhea-pm/config.delta.yaml"), "utf8"), /# keep me: an operator comment/u);
  assert.deepEqual(body.speaks, { voice: "brule", provider: "vox", source: "pinned" });
  const again = await flume(["rhea-pm", "--assign", "brule", "--apply"]);
  assert.equal(again.body.changed, false, "idempotent");
});

await check("an unknown voice is refused without --clone", async () => {
  const { status, body } = await flume(["rhea-pm", "--assign", "nobody", "--apply"]);
  assert.equal(status, 1);
  assert.equal(body.blockers[0].code, "unknown-voice");
  assert.equal(delta("rhea-pm").tts.voice, "brule", "nothing written");
});

await check("--clone of an existing voice is refused unless --force", async () => {
  const { status, body } = await flume(["rhea-pm", "--assign", "walken", "--clone", "Christopher Walken", "--apply"]);
  assert.equal(status, 1);
  assert.equal(body.blockers[0].code, "voice-exists");
});

await check("--clone --apply runs voxxy voice clone, then pins the new voice", async () => {
  const { status, body } = await flume(["ivy-pm", "--assign", "meg", "--clone", "Meg from Family Guy", "--pick", "2", "--apply", "--no-reload"]);
  assert.equal(status, 0, JSON.stringify(body));
  const argv = readFileSync(CLONELOG, "utf8").trim().split("\n").at(-1);
  assert.match(argv, /^voice clone Meg from Family Guy --name meg --yes --pick 2$/u);
  assert.equal(body.clone.status, "cloned");
  assert.equal(generated("ivy-pm").tts.voice, "meg");
});

await check("a clone voxxy refuses (exit 5: --pick needed) pins nothing", async () => {
  const { status, body } = await flume(["rhea-pm", "--assign", "stewie", "--clone", "Stewie from Family Guy", "--apply"], { VOXXY_FAKE_EXIT: "5" });
  assert.equal(status, 1);
  assert.equal(body.blockers[0].code, "clone-failed");
  assert.match(body.blockers[0].detail, /--pick N/u);
  assert.equal(delta("rhea-pm").tts.voice, "brule");
});

await check("--clear --apply drops the pin: the desk speaks the fleet default again", async () => {
  const { status, body } = await flume(["rhea-pm", "--clear", "--apply"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(delta("rhea-pm").tts.voice, undefined);
  assert.equal(generated("rhea-pm").tts.voice, "kurzgesagt");
  assert.equal(body.speaks.source, "fleet default");
});

await check("inside a desk the employee defaults to that desk (HERMES_HOME)", async () => {
  const { status, body } = await flume([], { HERMES_HOME: join(FLEET, "profiles", "ivy-pm") });
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(body.employee, "ivy-pm");
  assert.equal(body.speaks.voice, "meg");
});

server.close();
if (!failures) rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall identity-voice cases passed");
process.exit(failures ? 1 : 0);
