import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createServer } from "node:net";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// A separate thread keeps the real AF_UNIX peer responsive even when a suite
// uses spawnSync for the CLI. It implements ONLY Hermes' existing identify verb.
if (!isMainThread) {
  let state = "ready";
  let profiles = workerData.profiles;
  const requests = [];
  const clients = new Set();
  const server = createServer((client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.once("data", (bytes) => {
      const request = JSON.parse(bytes.toString("utf8"));
      requests.push(request);
      if (request.verb !== "identify") return client.destroy();
      client.end(`${JSON.stringify({ protocol: 1, id: request.id, ok: true, result: {
        runtime_protocol: 1, hermes_home: workerData.home, state,
        capabilities: ["session-authority-v1"],
        served_profiles: profiles.map((profile) => ({ profile_id: profile, home: profile })),
      } })}\n`);
    });
  });
  server.listen(workerData.socket, () => parentPort.postMessage({ ready: true }));
  parentPort.on("message", (message) => {
    if (message.state) { state = message.state; parentPort.postMessage({ updated: true }); }
    if (message.profiles) { profiles = message.profiles; parentPort.postMessage({ updated: true }); }
    if (message.stop) {
      for (const client of clients) client.destroy();
      server.close(() => { parentPort.postMessage({ requests }); parentPort.close(); });
    }
  });
}

export async function startGatewayIdentify(home, profiles, socketDirectory) {
  const socket = join(socketDirectory, "s");
  const pointer = join(home, "gateway.sock.path");
  const worker = new Worker(new URL(import.meta.url), { workerData: { home, profiles, socket } });
  const message = () => new Promise((ok, reject) => {
    const done = (value) => { worker.off("error", failed); ok(value); };
    const failed = (error) => { worker.off("message", done); reject(error); };
    worker.once("message", done);
    worker.once("error", failed);
  });
  await message();
  writeFileSync(pointer, socket, { mode: 0o600 });
  return {
    async state(value) { const pending = message(); worker.postMessage({ state: value }); await pending; },
    async profiles(value) { const pending = message(); worker.postMessage({ profiles: value }); await pending; },
    async stop() {
      const pending = message(); worker.postMessage({ stop: true });
      const { requests } = await pending;
      await worker.terminate();
      rmSync(pointer, { force: true });
      rmSync(socket, { force: true });
      return requests;
    },
  };
}
