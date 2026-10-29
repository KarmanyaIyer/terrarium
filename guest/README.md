# Terrarium guest image

Alpine 3.23 micro-VM image for the `vm` env driver (`apps/backend/src/envs/vm/`), built with Gondolin 0.14
(`@earendil-works/gondolin`, pinned in `apps/backend/package.json`).

## Build

Prerequisites (Homebrew): `brew install lz4 e2fsprogs qemu`, then `pnpm install` at the repo root.

```sh
guest/build.sh
```

The build takes about 45 s cold and 15 to 25 s warm. It needs no container runtime and no network once
the Alpine packages are cached. The script:

1. builds `terrarium-guest.json` into a temporary dir and verifies it,
2. checks that Gondolin imported it into the image store, `data/images/objects/<buildId>/`, and verifies that copy,
3. writes `<buildId>` to `data/images/current`, which is what the driver boots.

Rebuilding never changes an existing image. Env disks are qcow2 overlays backed by their image's
`rootfs.ext4`, and each env records its `imageId`. Remove old images with
`apps/backend/node_modules/.bin/gondolin image rm <id>`, with `GONDOLIN_IMAGE_STORE=data/images` set,
once no env or snapshot uses them.

`data/` (or `$TERRARIUM_DATA`) is the root for everything here. These dirs are created with mode 0700:
`images/` (image store), `gondolin/sessions/` (`GONDOLIN_SESSIONS_DIR`) and `gondolin/cache/` (Alpine
packages and krunfw, via `XDG_CACHE_HOME`). Each env's MITM CA lives in `<envDir>/mitm/`.

## Verify

```sh
guest/verify.sh               # policy unit tests + VM integration tests (boots VMs, max 2 at once)
guest/verify.sh --policy-only
```

Results go to `data/vm-verify/latest.json`.

## What's in the image

| Item | Detail |
| --- | --- |
| Base | Alpine 3.23.7, `linux-virt` kernel (QEMU), krunfw v5.2.1 kernel (krun, the default backend) |
| Tools | bash, coreutils, findutils, diffutils, patch, procps-ng, setpriv, file, less, curl, jq, ripgrep, inotify-tools, git, build-base (gcc 15), python3 3.12 + pip, nodejs 24 + npm |
| Size | rootfs.ext4 about 600 MB (571 MiB allocated), 614 MB for the whole image dir |
| Chromium | Not included. `chromium` alone is about 272 MB installed on Alpine 3.23 (APKINDEX), before its dependencies (mesa, fonts, ICU and so on), so roughly +45% or more on the rootfs and on every cold copy |

## Guest layout and users

- `agent` (uid/gid 1000, home `/home/agent`, shell bash) owns `/workspace`. Model commands run as
  agent through `setpriv --no-new-privs --bounding-set=-all`, so setuid binaries (`su`) can't regain
  root. The root password is locked.
- `grader` (uid/gid 1001, no home, no shell) runs hidden eval tests. It can read `/grader` (root:grader
  0750, files 0640); the agent can't, and the grader can't write the workspace.
- `rootfs-init-extra.sh` runs `/usr/local/libexec/terrarium/setup` as root on every boot from the Gondolin
  init. `setup` creates both users if missing, sets permissions, makes `/var/lib/terrarium`,
  `/var/lib/terrarium-grade` and `/run/terrarium/{exec,xfer}` root-only, mounts cgroup2 at
  `/sys/fs/cgroup` with a `terrarium/` subtree, shortens the dirty writeback interval and removes pip's
  `EXTERNALLY-MANAGED` marker. `postBuild.commands` would force a container build on macOS, so all setup
  happens here instead.
- `/usr/local/libexec/terrarium/` holds root-owned helpers:
  - `run <id> <agent|grader|root> <cwd> argv...`: exec launcher. Each exec gets its own cgroup
    (`/sys/fs/cgroup/terrarium/<who>-<id>`) and a `pid starttime` record under `/run/terrarium/exec/`.
  - `kill <id>`: `cgroup.kill` on that exec's cgroup (catches `setsid` and double forks), then the old
    process group and session kill as a fallback.
  - `kill-user <agent|grader>`: kills every process of that user: all their cgroups, then any pid left with
    that uid. The backend runs it at the end of every session run and before grading.
  - `put <id> <stage> <dest> [mode]`: writes a staged file as agent. Writes then honour uid 1000
    permissions and guest symlinks.
  - `read.py`: the only way the host reads guest files. JSON on stdin (paths, per-file and total caps);
    opens each path component with `O_NOFOLLOW` (root reads; `--follow` when run as agent), `O_NONBLOCK`,
    and reads only regular files (`fstat` S_ISREG), so a FIFO, `/dev/zero` or a symlink into a root-only
    dir can't block, flood or leak. The driver adds a 30 s exec timeout.
  - `grade.py` with `grade_rpc.py`, `grade_worker.py`, `grade_runner.py`: hidden-test grading (eval check
    type `tests`). As root it kills every agent process, copies the workspace to a job dir, starts the
    candidate's code in a worker as `agent` and the hidden tests in a runner as `grader` (`python3 -I -S`),
    connected by a socketpair. Plain values cross by value, everything else as references, and a
    comparison between a reference and a test-side value is refused, so candidate code never sees the
    expected values. The runner writes its counts to a dir only `grader` can write; pass means passed ==
    expected > 0 there. Candidate exits, `sys.exit`, patched `unittest`, forged results files and
    leftover daemons all fail.
  - `observer.py`: the manifest walker. It runs as root with `python3 -I -S` and prints JSON
    entries for path, type, size, mode, mtimeNs, ctimeNs, ino, nlink, linkTarget and sha256.
    - Walks fd-relative with `O_NOFOLLOW`, so symlinks are never followed.
    - sha256 covers regular files that are new or whose (size, mtime, ctime, ino) changed, or every file with `--all`.
    - Heavy dirs (`node_modules`, `.venv`, `__pycache__`, `.git/objects` and others) are listed but not hashed.
    - Capped at 20,000 entries. Files over 256 MiB are listed without a hash.
    - 1,017 entries take 2 ms inside the guest and about 50 ms round trip from the host.
- Helper migration: at boot the driver compares a sha256 of the guest's helper files with the backend's
  copy (`guest/files/usr/local/libexec/terrarium`, shipped in the app bundle too). If they differ, it
  pushes the current helpers and reruns `setup`, so envs on an older image get the grader user, cgroups
  and safe reads without a rebuild.

## Gotchas

- The guest's PID 1 (Gondolin's sandboxd) only reaps its own children. Orphans that get killed stay
  as zombies until the VM restarts. They hold no memory or files, but they do show up in `ps`.
- Every boot runs `rootfs-init-extra.sh` under `set -eu`, wrapped so that a failure can't stop the
  boot. A broken change there only shows up as missing users or permissions.
- Changing the package list needs a rebuild. Existing envs keep booting their recorded image (by
  absolute path) until they are recreated; helper changes reach them through the boot-time migration.
