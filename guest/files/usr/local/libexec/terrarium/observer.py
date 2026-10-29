#!/usr/bin/python3 -I -S
"""Terrarium workspace observer. Runs as root inside the guest; prints a JSON manifest of a directory.

usage: observer.py [--root /workspace] [--max-entries 20000] [--max-hash-bytes N] [--prev -|--all]

--prev F  reads the previous manifest from file F (deleted after reading; "-" = stdin) as JSON:
          [[path, size, mtime_ns, ctime_ns, ino, sha256], ...] and only hashes regular files whose
          (size, mtime, ctime, ino) differ from it (or that are new).
--all     hashes every regular file (default when --prev is not given).

Traversal never follows symlinks: every directory and file is opened relative to its parent's fd with
O_NOFOLLOW, so swapping a path for a link mid-walk can't redirect the observer. Files are opened with
O_NONBLOCK (FIFOs can't stall it) and re-checked with fstat (same inode, regular file) before hashing.
Heavy dirs are listed but not hashed, and walked after everything else so the entry cap drops them first.
"""
import hashlib
import json
import os
import stat
import sys
import time

HEAVY_NAMES = {"node_modules", ".venv", "venv", "__pycache__", ".cache", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox"}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC
MAX_DEPTH = 128


def kind(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def is_heavy_dir(rel, name):
    return name in HEAVY_NAMES or rel == ".git/objects" or rel.endswith("/.git/objects")


def open_rel(root_fd, rel):
    """Open root/rel as a directory, one O_NOFOLLOW component at a time."""
    fd = os.dup(root_fd)
    if not rel:
        return fd
    try:
        for comp in rel.split("/"):
            nfd = os.open(comp, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nfd
        return fd
    except OSError:
        os.close(fd)
        raise


def sha256_at(dir_fd, name, st, limit):
    if st.st_size > limit:
        return None
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=dir_fd)
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or fst.st_ino != st.st_ino or fst.st_dev != st.st_dev:
            return None
        h = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None
    finally:
        os.close(fd)


def main(argv):
    root = "/workspace"
    max_entries = 20000
    max_hash = 256 << 20
    prev = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--root":
            root = argv[i + 1]; i += 2
        elif a == "--max-entries":
            max_entries = int(argv[i + 1]); i += 2
        elif a == "--max-hash-bytes":
            max_hash = int(argv[i + 1]); i += 2
        elif a == "--prev":
            src = argv[i + 1]; i += 2
            if src == "-":
                data = json.load(sys.stdin)
            else:
                with open(src, "rb") as f:
                    data = json.load(f)
                os.unlink(src)
            prev = {row[0]: row for row in data}
        elif a == "--all":
            prev = None; i += 1
        else:
            sys.stderr.write("unknown argument " + a + "\n")
            return 2
    root = root.rstrip("/") or "/"
    if not root.startswith("/") or "/../" in root + "/" or "/./" in root + "/":
        sys.stderr.write("root must be an absolute, normalized path\n")
        return 2
    t0 = time.monotonic()
    try:
        # Every component of the root itself is opened with O_NOFOLLOW too.
        slash_fd = os.open("/", DIR_FLAGS)
        try:
            root_fd = open_rel(slash_fd, root.strip("/"))
        finally:
            os.close(slash_fd)
    except OSError as e:
        sys.stderr.write("cannot open root " + root + ": " + (e.strerror or str(e)) + "\n")
        return 1

    base = "" if root == "/" else root
    entries = []
    truncated = False
    hashed = 0
    hashed_bytes = 0
    # Work items: (rel_dir, heavy, depth). Normal dirs depth-first; heavy dirs only after all normal ones.
    stack = [("", False, 0)]
    heavy_queue = []

    while stack or heavy_queue:
        rel_dir, heavy, depth = stack.pop() if stack else heavy_queue.pop(0)
        if len(entries) >= max_entries:
            truncated = True
            break
        try:
            dfd = open_rel(root_fd, rel_dir)
        except OSError:
            continue
        try:
            try:
                names = sorted(os.listdir(dfd))
            except OSError:
                names = []
            children = []
            for name in names:
                if len(entries) >= max_entries:
                    truncated = True
                    break
                rel = rel_dir + "/" + name if rel_dir else name
                try:
                    st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                except OSError:
                    continue
                t = kind(st.st_mode)
                e = {
                    "path": base + "/" + rel,
                    "type": t,
                    "size": st.st_size,
                    "mode": stat.S_IMODE(st.st_mode),
                    "mtimeNs": str(st.st_mtime_ns),
                    "ctimeNs": str(st.st_ctime_ns),
                    "ino": st.st_ino,
                    "nlink": st.st_nlink,
                }
                if heavy:
                    e["heavy"] = True
                if t == "symlink":
                    try:
                        e["linkTarget"] = os.readlink(name, dir_fd=dfd)
                    except OSError:
                        pass
                elif t == "file" and not heavy:
                    old = prev.get(e["path"]) if prev is not None else None
                    if old is not None and old[5] and old[1] == st.st_size and old[2] == e["mtimeNs"] and old[3] == e["ctimeNs"] and old[4] == st.st_ino:
                        e["sha256"] = old[5]
                    else:
                        digest = sha256_at(dfd, name, st, max_hash)
                        if digest is not None:
                            e["sha256"] = digest
                            hashed += 1
                            hashed_bytes += st.st_size
                elif t == "dir":
                    if depth + 1 >= MAX_DEPTH:
                        truncated = True
                    elif heavy:
                        children.append((rel, True, depth + 1))
                    elif is_heavy_dir(rel, name):
                        e["heavy"] = True
                        heavy_queue.append((rel, True, depth + 1))
                    else:
                        children.append((rel, False, depth + 1))
                entries.append(e)
            # Reverse so the depth-first pop order visits children alphabetically.
            stack.extend(reversed(children))
        finally:
            os.close(dfd)

    os.close(root_fd)
    entries.sort(key=lambda x: x["path"])
    out = {
        "root": root,
        "takenAt": int(time.time() * 1000),
        "entries": entries,
        "truncated": truncated,
        "stats": {"entries": len(entries), "hashed": hashed, "hashedBytes": hashed_bytes, "ms": round((time.monotonic() - t0) * 1000, 1)},
    }
    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
