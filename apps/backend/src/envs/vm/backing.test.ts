// A moved data dir leaves overlays backed by an absolute path that no longer exists; boot repoints them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { qemuImgPath } from "./gondolin.ts";
import { repointStaleBacking } from "./driver.ts";

const qemuImg = qemuImgPath();
const IMAGE_ID = "37190e93-4fd4-534c-91b1-95b97a20f741";
let tmp = "";
let prevData: string | undefined;

function backingOf(disk: string): string {
  return JSON.parse(execFileSync(qemuImg!, ["info", "--output=json", "-U", disk], { encoding: "utf8" }))["backing-filename"];
}

function makeImage(dataRoot: string): string {
  const dir = path.join(dataRoot, "images", "objects", IMAGE_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ buildId: IMAGE_ID, assets: { rootfs: "rootfs.ext4" } }));
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), Buffer.alloc(1 << 20));
  return path.join(dir, "rootfs.ext4");
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terrarium-backing-"));
  prevData = process.env.TERRARIUM_DATA;
  process.env.TERRARIUM_DATA = path.join(tmp, "new", "data");
});

after(() => {
  if (prevData === undefined) delete process.env.TERRARIUM_DATA;
  else process.env.TERRARIUM_DATA = prevData;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("repoints a disk whose base image moved with the data dir", { skip: !qemuImg && "qemu-img missing" }, async () => {
  const oldRoot = path.join(tmp, "old", "data");
  const oldRootfs = makeImage(oldRoot);
  const newRootfs = makeImage(process.env.TERRARIUM_DATA!);
  const disk = path.join(tmp, "disk.qcow2");
  execFileSync(qemuImg!, ["create", "-q", "-f", "qcow2", "-F", "raw", "-b", oldRootfs, disk]);
  fs.rmSync(oldRoot, { recursive: true });

  assert.equal(await repointStaleBacking(disk), newRootfs);
  assert.equal(backingOf(disk), newRootfs);
  assert.equal(await repointStaleBacking(disk), null, "a valid backing file is left alone");
});

test("a missing base image with no copy under the data dir fails with a clear error", { skip: !qemuImg && "qemu-img missing" }, async () => {
  const gone = path.join(tmp, "gone", "images", "objects", "00000000-0000-0000-0000-000000000000", "rootfs.ext4");
  fs.mkdirSync(path.dirname(gone), { recursive: true });
  fs.writeFileSync(gone, Buffer.alloc(1 << 20));
  const disk = path.join(tmp, "orphan.qcow2");
  execFileSync(qemuImg!, ["create", "-q", "-f", "qcow2", "-F", "raw", "-b", gone, disk]);
  fs.rmSync(path.join(tmp, "gone"), { recursive: true });
  await assert.rejects(repointStaleBacking(disk), /needs base image .* which is missing/);
  assert.equal(backingOf(disk), gone, "header untouched");
});
