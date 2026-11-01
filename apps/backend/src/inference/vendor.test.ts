// Vendored mlx-lm model files: installed into a venv once, updated when the vendored copy changes, never written
// over a file mlx-lm itself ships.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { installVendoredModels, mlxLmModelsDir, VENDOR_DIR, VENDOR_MARKER } from "./vendor.ts";

const dir = mkdtempSync(join(tmpdir(), "terrarium-vendor-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function fakeVenv(name: string): string {
  const venv = join(dir, name);
  const models = join(venv, "lib", "python3.13", "site-packages", "mlx_lm", "models");
  mkdirSync(models, { recursive: true });
  writeFileSync(join(models, "base.py"), "");
  return venv;
}

test("installs once, then reports current, and updates an older vendored copy", () => {
  const venv = fakeVenv("a");
  const src = join(dir, "src-a");
  mkdirSync(src);
  writeFileSync(join(src, "lfm3.py"), `${VENDOR_MARKER} v1\n`);
  assert.deepEqual(installVendoredModels(venv, src), { "lfm3.py": "installed" });
  assert.deepEqual(installVendoredModels(venv, src), { "lfm3.py": "current" });
  writeFileSync(join(src, "lfm3.py"), `${VENDOR_MARKER} v2\n`);
  assert.deepEqual(installVendoredModels(venv, src), { "lfm3.py": "updated" });
  assert.equal(readFileSync(join(mlxLmModelsDir(venv)!, "lfm3.py"), "utf8"), `${VENDOR_MARKER} v2\n`);
});

test("leaves a file mlx-lm ships alone", () => {
  const venv = fakeVenv("b");
  const upstream = join(mlxLmModelsDir(venv)!, "lfm3.py");
  writeFileSync(upstream, "# Copyright © 2026 Apple Inc.\n");
  assert.deepEqual(installVendoredModels(venv), { "lfm3.py": "upstream" });
  assert.equal(readFileSync(upstream, "utf8"), "# Copyright © 2026 Apple Inc.\n");
});

test("does nothing without mlx-lm in the venv", () => {
  assert.equal(mlxLmModelsDir(join(dir, "none")), undefined);
  assert.deepEqual(installVendoredModels(join(dir, "none")), {});
});

test("the shipped lfm3.py starts with the marker", () => {
  assert.ok(readFileSync(join(VENDOR_DIR, "lfm3.py"), "utf8").startsWith(VENDOR_MARKER));
});
