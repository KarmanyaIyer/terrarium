import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SimRuntime, seedState } from "./runtime.ts";

const dir = process.argv[2];
const worker = process.argv[3];
if (!dir || !worker) process.exit(64);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "state.json"), JSON.stringify(seedState()));
const rt = new SimRuntime("wedged-parent", dir, { python: false, javascript: false, maxTotalBytes: 8 * 1024 * 1024 }, "off", { workerPath: worker, workerArgs: ["wedge"] });
await rt.start();
process.stdout.write(`${JSON.stringify({ guardPid: rt.guardPid, workerPid: rt.pid })}\n`);
await rt.exec("loop forever", { timeoutMs: 10 * 60_000 });
