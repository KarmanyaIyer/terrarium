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
- `rootfs-init-extra.sh` runs as root on every boot from the Gondolin init. It creates the user if
  missing, sets permissions, makes `/var/lib/terrarium` and `/run/terrarium/{exec,xfer}` root-only
  (0700), shortens the dirty writeback interval and removes pip's `EXTERNALLY-MANAGED` marker.
  `postBuild.commands` would force a container build on macOS, so all setup happens here instead.
- `/usr/local/libexec/terrarium/` holds root-owned helpers:
  - `run <id> <agent|root> <cwd> argv...`: exec launcher. It records `pid starttime` under
    `/run/terrarium/exec/` so the driver can kill the whole session on timeout or abort.
  - `kill <id>`: kills that session (`kill -KILL -- -pid` plus `pkill -s`) after checking starttime.
  - `put <id> <stage> <dest> [mode]`: writes a staged file as agent. Writes then honour uid 1000
    permissions and guest symlinks.
  - `observer.py`: the manifest walker. It runs as root with `python3 -I -S` and prints JSON
    entries for path, type, size, mode, mtimeNs, ctimeNs, ino, nlink, linkTarget and sha256.
    - Walks fd-relative with `O_NOFOLLOW`, so symlinks are never followed.
    - sha256 covers regular files that are new or whose (size, mtime, ctime, ino) changed, or every file with `--all`.
    - Heavy dirs (`node_modules`, `.venv`, `__pycache__`, `.git/objects` and others) are listed but not hashed.
    - Capped at 20,000 entries. Files over 256 MiB are listed without a hash.
    - 1,017 entries take 2 ms inside the guest and about 50 ms round trip from the host.

## Gotchas

- The guest's PID 1 (Gondolin's sandboxd) only reaps its own children. Orphans that get killed stay
  as zombies until the VM restarts. They hold no memory or files, but they do show up in `ps`.
- Every boot runs `rootfs-init-extra.sh` under `set -eu`, wrapped so that a failure can't stop the
  boot. A broken change there only shows up as missing users or permissions.
- Changing the package list or helpers needs a rebuild. Existing envs keep booting their recorded
  image until they are recreated.
