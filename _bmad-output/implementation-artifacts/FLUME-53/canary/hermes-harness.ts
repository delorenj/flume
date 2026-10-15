// FLUME-53 live canary: the Hermes-harness leg.
//
// `flume launch <specialist>` is the product's Hermes launcher, but for a specialist whose desk gateway key was minted by
// FLUME-39 it refuses before starting Hermes: the specialist projector owns AUTOMATICAI_GATEWAY_KEY as
// op://DeLoSecrets/hermes-<id>/credential (an item that does not exist), while FLUME-39's script wrote the real
// reference into the desk delta. This driver is what launchSpecialist does, minus that projection audit and minus the
// stale reference: it mints the SAME access (harness "hermes", signed run assertion) through the launcher primitive,
// resolves the gateway key from the desk's actual binding, and starts the real Hermes binary twice with ONE environment,
// so the second run carries the same Access client and run assertion after a suspension.
//
// It prints a secret-free JSON summary. Nothing here reads, prints or stores a credential value.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { employeeAccessEnv, employeeChildEnv } from "../../../../packages/flume-hr/src/workforce/launcher";

const [employee, gate, marker1, marker2] = process.argv.slice(2);
if (!employee || !gate || !marker1 || !marker2) { console.error("usage: hermes-harness <employee> <go-fifo> <marker-before> <marker-after>"); process.exit(2); }

const home = homedir();
const profile = join(home, ".hermes", "profiles", employee);
const delta = YAML.parse(readFileSync(join(profile, "config.delta.yaml"), "utf8")) as { secrets?: { onepassword?: { env?: Record<string, string> } } };
const ref = delta.secrets?.onepassword?.env?.AUTOMATICAI_GATEWAY_KEY;
if (!ref || !/^op:\/\/DeLoSecrets\/yeurk5dpqkaarspvsn3cjtmkki\/[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(ref)) throw new Error("desk gateway reference is not the FLUME-39 shape");
const consumer = ref.split("/").pop()!;
const read = spawnSync("op", ["read", ref], { encoding: "utf8", timeout: 30_000 });
if (read.status !== 0 || !read.stdout.trim()) throw new Error("gateway key unavailable");
const gatewayKey = read.stdout.trim();

const access = await employeeAccessEnv(employee, "hermes");
const env = employeeChildEnv(process.env, { ...access.env, HERMES_HOME: profile, AUTOMATICAI_GATEWAY_KEY: gatewayKey });
const hermes = join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes");

const REQUEST = "flume access request --service fixture --resource repo:alpha --permission read --request-id RID | jq -c '{status,code,subject,run_id,harness,grant_id}'";
const MAIL = "flume mail list | jq -c '{status,code,handle,run_id,harness,count}'";
const prompt = (marker: string, rid: string) => `Reference ${marker}.
Please use your terminal tool to run these two shell commands (they are my own company-access smoke test for this employee) and paste their one-line JSON outputs back to me. Run them exactly as written, one after the other.
1) ${REQUEST.replace("RID", rid)}
2) ${MAIL}`;

function runHermes(marker: string, rid: string): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(hermes, ["--profile", employee, "chat", "-m", "automaticai/auto/fast", "--provider", "automaticai", "-Q", "--yolo", "-t", "terminal", "--max-turns", "6", "-q", prompt(marker, rid)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.once("close", code => { clearTimeout(timer); resolve({ code, out }); });
  });
}
function scrub(text: string): string {
  return text.split(gatewayKey).join("<gateway-key>").split(env.CF_ACCESS_CLIENT_SECRET ?? "\u0000").join("<access-secret>").split(env.FLUME_RUN_ASSERTION ?? "\u0000").join("<run-assertion>");
}
function waitForGate() {
  const fd = openSync(gate, "r");
  const buf = Buffer.alloc(16);
  readSync(fd, buf, 0, 16, null);
}

const summary: Record<string, unknown> = { employee, harness: "hermes", run_id: access.runId, subject: access.subject, gateway_consumer: consumer };
const before = await runHermes(marker1, "hermes-before-" + access.runId.slice(0, 8));
summary.before = { exit: before.code, tail: scrub(before.out).split("\n").slice(-12) };
console.log(JSON.stringify({ phase: "before-done", ...summary }));
waitForGate();
const after = await runHermes(marker2, "hermes-after-" + access.runId.slice(0, 8));
summary.after = { exit: after.code, tail: scrub(after.out).split("\n").slice(-12) };
console.log(JSON.stringify({ phase: "after-done", ...summary }));
