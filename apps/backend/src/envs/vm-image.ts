// The guest image on a fresh data dir: guest/build.sh writes it, about a minute cold. Asked for from the first-run UI.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VmSetup } from "@terrarium/shared";
import { REPO_DIR } from "../config.ts";
import { HttpError } from "../util/errors.ts";
import type { EnvDriver } from "./types.ts";

const BUILD_TIMEOUT_MS = 10 * 60_000;

export class VmImage {
  private driver: EnvDriver | null;
  private dataDir: string;
  private script: string;
  private building: Promise<VmSetup> | null = null;

  constructor(opts: { driver: EnvDriver | null; dataDir: string; script?: string }) {
    this.driver = opts.driver;
    this.dataDir = opts.dataDir;
    this.script = opts.script ?? join(REPO_DIR, "guest", "build.sh");
  }

  async status(): Promise<VmSetup> {
    if (!this.driver) return { ok: false, detail: "This build has no VM driver" };
    const c = await this.driver.check();
    return c.ok ? { ok: true } : { ok: false, detail: c.detail };
  }

  /** One build at a time; a second request joins the first. */
  build(): Promise<VmSetup> {
    this.building ??= this.run().finally(() => (this.building = null));
    return this.building;
  }

  private async run(): Promise<VmSetup> {
    if (!existsSync(this.script)) throw new HttpError(503, `No VM image build script at ${this.script}`);
    await new Promise<void>((resolve, reject) => {
      // an app started from Finder doesn't get the shell's PATH; the script needs Homebrew's lz4, qemu and e2fsprogs
      const env = { ...process.env, TERRARIUM_DATA: this.dataDir, PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}` };
      const child = spawn("/bin/sh", [this.script], { env, stdio: ["ignore", "pipe", "pipe"] });
      let tail = "";
      const keep = (b: Buffer) => (tail = (tail + b.toString("utf8")).slice(-2000));
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const last = tail.trim().split("\n").at(-1) ?? "";
        reject(new HttpError(500, last || `The VM image build failed (exit ${code})`));
      });
    });
    return this.status();
  }
}
