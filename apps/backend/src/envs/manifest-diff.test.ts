import assert from "node:assert/strict";
import { test } from "node:test";
import { diffManifests, manifestTree } from "./manifest-diff.ts";
import type { Manifest, ManifestEntry } from "./types.ts";

const e = (path: string, type: ManifestEntry["type"], extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
  path,
  type,
  size: 0,
  mode: type === "dir" ? 0o755 : 0o644,
  mtimeNs: "1",
  ino: 0,
  nlink: 1,
  ...extra,
});
const m = (entries: ManifestEntry[]): Manifest => ({ root: "/workspace", takenAt: 0, entries, truncated: false });

const before = m([
  e("/workspace/src", "dir"),
  e("/workspace/src/a.py", "file", { size: 3, sha256: "aaa" }),
  e("/workspace/src/b.py", "file", { size: 3, sha256: "bbb" }),
  e("/workspace/src/c.py", "file", { size: 3, sha256: "ccc" }),
  e("/workspace/run.sh", "file", { size: 9, sha256: "rrr" }),
  e("/workspace/link", "symlink", { linkTarget: "src/a.py" }),
  e("/workspace/node_modules/x/index.js", "file", { size: 10, mtimeNs: "5", heavy: true }),
  e("/workspace/old", "dir"),
  e("/workspace/old/gone.txt", "file", { size: 1, sha256: "ggg" }),
]);
const after = m([
  e("/workspace/src", "dir", { mtimeNs: "9" }), // dir mtime changes alone are not reported
  e("/workspace/src/a.py", "file", { size: 4, sha256: "aaa2" }),
  e("/workspace/src/b.py", "file", { size: 3, sha256: "bbb", mtimeNs: "7" }), // touched, same content
  e("/workspace/run.sh", "file", { size: 9, sha256: "rrr", mode: 0o755 }), // chmod +x
  e("/workspace/link", "symlink", { linkTarget: "src/b.py" }),
  e("/workspace/node_modules/x/index.js", "file", { size: 10, mtimeNs: "6", heavy: true }), // unhashed: size+mtime
  e("/workspace/new.txt", "file", { size: 2, sha256: "nnn" }),
  e("/workspace/old", "file", { size: 1, sha256: "ooo" }), // dir replaced by a file
]);

test("diffManifests reports content, mode, link, heavy and type changes; ignores touch and dir mtime", () => {
  const changes = diffManifests(before, after);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
  assert.deepEqual(byPath, {
    "/workspace/src/a.py": "modified",
    "/workspace/run.sh": "modified",
    "/workspace/link": "modified",
    "/workspace/node_modules/x/index.js": "modified",
    "/workspace/new.txt": "added",
    "/workspace/old": "type_changed",
    "/workspace/old/gone.txt": "deleted",
    "/workspace/src/c.py": "deleted",
  });
  const a = changes.find((c) => c.path === "/workspace/src/a.py")!;
  assert.deepEqual(a.before, { sha256: "aaa", size: 3, mode: 0o644, type: "file" });
  assert.equal(a.after?.sha256, "aaa2");
  assert.deepEqual(changes.map((c) => c.path), [...changes.map((c) => c.path)].sort());
});

test("manifestTree nests, sorts dirs first, marks changes and keeps deleted nodes", () => {
  const tree = manifestTree(after, before);
  assert.equal(tree.path, "/workspace");
  const names = tree.children!.map((c) => c.name);
  assert.deepEqual(names.slice(0, 2), ["node_modules", "src"]);
  const src = tree.children!.find((c) => c.name === "src")!;
  assert.equal(src.children!.find((c) => c.name === "a.py")!.change, "modified");
  assert.equal(src.children!.find((c) => c.name === "b.py")!.change, undefined);
  assert.equal(tree.children!.find((c) => c.name === "new.txt")!.change, "added");
  assert.equal(src.children!.find((c) => c.name === "c.py")!.change, "deleted");
  const old = tree.children!.find((c) => c.name === "old")!;
  assert.equal(old.type, "file");
  assert.equal(old.change, "type_changed");
  assert.equal(old.children, undefined, "a deleted child of a dir that became a file is not attached to the file");
  assert.equal(manifestTree(after).children!.find((c) => c.name === "new.txt")!.change, undefined);
});
