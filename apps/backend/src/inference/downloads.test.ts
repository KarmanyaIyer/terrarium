import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freeDisk } from "./downloads.ts";

test("free disk is measured on the parent when models/ doesn't exist yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-disk-"));
  try {
    const st = statfsSync(dir);
    const free = freeDisk(join(dir, "models", "deeper"));
    assert.ok(free > 0);
    assert.ok(Math.abs(free - st.bavail * st.bsize) < 1e9, "same disk as the parent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
