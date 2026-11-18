"""Run the real interactive ingredient against a stalled, synthetic op executable."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="flume-40-timeout-", dir=os.environ.get("TMPDIR")) as directory:
    work = Path(directory)
    (work / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
    (work / "bin").mkdir()
    op = work / "bin" / "op"
    op.write_text("#!/bin/sh\nexec sleep 30\n")
    op.chmod(0o755)
    (work / "prompts.mjs").write_text(
        'export const log = {warn: console.log, info: console.log, step: console.log}; '
        'export const password = async () => { throw Error("unexpected token prompt") }; '
        'export const confirm = async () => { throw Error("unexpected token persistence prompt") }; '
        'export const text = async ({validate}) => { '
        'if (validate("bad") === undefined || validate("700001") !== undefined) '
        'throw Error("manual validation failed"); return "700001" }; '
        'export const isCancel = () => false; '
        'export const spinner = () => ({ start(){}, stop(){} });'
    )
    source = root / "packages/flume-hr/src/hire/WireTelegram.ts"
    (work / "build.mjs").write_text(
        'import { buildSync } from "esbuild";\n'
        f'buildSync({{entryPoints:[{str(source)!r}], bundle:true, platform:"node", '
        'format:"esm", packages:"external", outfile:"bundle.mjs", '
        'alias:{"@clack/prompts":"./prompts.mjs"}});\n'
    )
    node = shutil.which("node")
    assert node is not None, "node is required for the fixture"
    subprocess.run([node, "build.mjs"], cwd=work, check=True, timeout=15)
    role = work / "role"
    (role / ".scripts").mkdir(parents=True)
    (role / ".scripts/30-telegram.sh").write_text(
        '#!/bin/sh\n[ "$TELEGRAM_ALLOWED_USERS" = "700001" ]\n'
    )
    (work / "invoke.mjs").write_text(
        'import {WireTelegram} from "./bundle.mjs"; '
        f'console.log(JSON.stringify(await new WireTelegram({{targetRepo:"demo",role:"pm",roleDir:{str(role)!r}}}).invoke()));'
    )
    env = {**os.environ, "PATH": str(work / "bin") + os.pathsep + os.environ["PATH"],
           "TELEGRAM_BOT_TOKEN": "123456:synthetic-token", "FLUME_HOST_OVERLAY": "none"}
    env.pop("TELEGRAM_ALLOWED_USERS", None)
    result = subprocess.run([node, "invoke.mjs"], cwd=work, env=env,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert "Could not resolve a numeric Telegram user id" in result.stdout, result.stdout
    assert '"success":true' in result.stdout, result.stdout
    print("FLUME-40 stalled fake op: bounded read, warning, validated manual ID and script handoff passed")
