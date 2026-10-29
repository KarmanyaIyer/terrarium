"""Terrarium file reader (`python3 -I -S`). Reads paths the agent may control without following it into a
FIFO, a device or a huge file. usage: read.py [--follow] < {"max": bytes-per-file, "total": bytes, "paths": [...]}

Without --follow (root reads), every path component is opened with O_NOFOLLOW, so no symlink anywhere in
the path is followed. With --follow (run as the agent, so its own permissions apply) symlinks resolve
normally. Either way the final open is O_NONBLOCK and fstat must say regular file before anything is read.

Output, per path in order: "ok <size> <n>\\n" then n bytes (n <= max), or "err <json message>\\n".
"""

import json
import os
import posixpath
import stat
import sys

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC


def open_nofollow(path):
    parts = [p for p in posixpath.normpath(path).split("/") if p]
    if not parts:
        raise OSError(21, "is a directory")
    fd = os.open("/", DIR_FLAGS)
    try:
        for p in parts[:-1]:
            nfd = os.open(p, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nfd
        return os.open(parts[-1], FILE_FLAGS | os.O_NOFOLLOW, dir_fd=fd)
    finally:
        os.close(fd)


def read_one(path, follow, cap):
    if not isinstance(path, str) or not path.startswith("/"):
        raise OSError(22, "path must be absolute")
    fd = os.open(path, FILE_FLAGS) if follow else open_nofollow(path)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise OSError(22, "not a regular file")
        chunks = []
        n = 0
        while n < cap:
            b = os.read(fd, min(1 << 20, cap - n))
            if not b:
                break
            chunks.append(b)
            n += len(b)
        return st.st_size, b"".join(chunks)
    finally:
        os.close(fd)


def main():
    follow = "--follow" in sys.argv[1:]
    req = json.loads(sys.stdin.read())
    cap = max(0, int(req.get("max", 32 << 20)))
    left = max(0, int(req.get("total", 64 << 20)))
    out = sys.stdout.buffer
    for path in req.get("paths", []):
        try:
            if left <= 0:
                raise OSError(27, "batch read limit reached")
            size, data = read_one(path, follow, min(cap, left))
            left -= len(data)
            out.write(b"ok %d %d\n" % (size, len(data)))
            out.write(data)
        except OSError as e:
            msg = e.strerror or str(e)
            if e.errno == 40:
                msg = "symlinks are not followed for this read"
            out.write(b"err " + json.dumps(msg).encode() + b"\n")
    out.flush()


if __name__ == "__main__":
    main()
