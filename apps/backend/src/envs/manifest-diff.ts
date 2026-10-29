// Pure functions over workspace manifests: change detection and FileNode trees for the UI.

import type { FileChange, FileChangeKind, FileNode } from "@terrarium/shared";
import type { Manifest, ManifestEntry } from "./types.ts";

function side(e: ManifestEntry): NonNullable<FileChange["before"]> {
  return { sha256: e.sha256, size: e.size, mode: e.mode, type: e.type };
}

/** Same content? Hashed files compare by sha256; heavy (unhashed) files fall back to size + mtime. */
function sameContent(a: ManifestEntry, b: ManifestEntry): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "symlink") return a.linkTarget === b.linkTarget;
  if (a.type === "dir") return true;
  if (a.sha256 && b.sha256) return a.sha256 === b.sha256;
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** Changes from `before` to `after`. Directories only appear when added, deleted or retyped. */
export function diffManifests(before: Manifest, after: Manifest): FileChange[] {
  const prev = new Map(before.entries.map((e) => [e.path, e]));
  const next = new Map(after.entries.map((e) => [e.path, e]));
  const changes: FileChange[] = [];
  for (const [path, a] of next) {
    const b = prev.get(path);
    if (!b) changes.push({ path, kind: "added", after: side(a) });
    else if (a.type !== b.type) changes.push({ path, kind: "type_changed", before: side(b), after: side(a) });
    else if (!sameContent(b, a) || (a.type !== "dir" && a.mode !== b.mode)) changes.push({ path, kind: "modified", before: side(b), after: side(a) });
  }
  for (const [path, b] of prev) if (!next.has(path)) changes.push({ path, kind: "deleted", before: side(b) });
  // When a whole directory disappears, report the directory and its files (UI collapses them).
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Nested FileNode tree rooted at manifest.root; `baseline` marks each node's change since then. */
export function manifestTree(manifest: Manifest, baseline?: Manifest | null): FileNode {
  const changeByPath = new Map<string, FileChangeKind>();
  if (baseline) for (const c of diffManifests(baseline, manifest)) changeByPath.set(c.path, c.kind);
  const root: FileNode = { path: manifest.root, name: manifest.root.split("/").pop() || "/", type: "dir", children: [] };
  const nodes = new Map<string, FileNode>([[manifest.root, root]]);
  const ensureDir = (path: string): FileNode => {
    let n = nodes.get(path);
    if (n) return n;
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const parent = path === manifest.root || !path.startsWith(manifest.root) ? root : ensureDir(parentPath);
    n = { path, name: path.split("/").pop() || path, type: "dir", children: [] };
    parent.children!.push(n);
    nodes.set(path, n);
    return n;
  };
  for (const e of [...manifest.entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (e.path === manifest.root) {
      root.mode = e.mode;
      continue;
    }
    const parent = ensureDir(e.path.slice(0, e.path.lastIndexOf("/")) || "/");
    let node = nodes.get(e.path);
    if (!node) {
      node = { path: e.path, name: e.path.split("/").pop() || e.path, type: e.type };
      if (e.type === "dir") node.children = [];
      parent.children!.push(node);
      nodes.set(e.path, node);
    }
    node.type = e.type;
    if (e.type !== "dir") node.size = e.size;
    node.mode = e.mode;
    if (e.linkTarget) node.linkTarget = e.linkTarget;
    if (e.sha256) node.sha256 = e.sha256;
    if (e.heavy) node.heavy = true;
    const change = changeByPath.get(e.path);
    if (change) node.change = change;
  }
  // Deleted paths stay visible in the tree, marked deleted.
  if (baseline) {
    for (const e of baseline.entries) {
      if (changeByPath.get(e.path) !== "deleted" || nodes.has(e.path)) continue;
      const parent = ensureDir(e.path.slice(0, e.path.lastIndexOf("/")) || "/");
      const node: FileNode = { path: e.path, name: e.path.split("/").pop() || e.path, type: e.type, size: e.size, change: "deleted" };
      if (e.type === "dir") node.children = [];
      parent.children!.push(node);
      nodes.set(e.path, node);
    }
  }
  const sortRec = (n: FileNode) => {
    n.children?.sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name));
    n.children?.forEach(sortRec);
  };
  sortRec(root);
  return root;
}
