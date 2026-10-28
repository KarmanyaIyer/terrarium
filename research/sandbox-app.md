# Terrarium: sandbox, workspace visibility, app shell, and security research

Date: 2026-10-28 (America/Chicago). Session: ce0a87e0-a444-4c59-9f26-165926af807d.
Machine: M5 MacBook Pro, 24 GB, macOS 27 (Darwin 27.0.0), Node 24.18.0, QEMU 11.1.2 (Homebrew).

Legend: **[V]** verified (source + date, or my experiment output in `research/scratch/`). **[I]** inferred or unmeasured.

Experiment scripts and raw output: `research/scratch/gtest/` (`boot.mjs`, `features.mjs`, `vfsbench.mjs`, `observe.mjs`, `jb.mjs`, `jb-worker.mjs`), `research/scratch/features-{qemu,krun}.json`, `research/scratch/sbx/jb.sb`. Upstream sources cloned read-only into `research/scratch/src/`. Every VM and process I started was stopped (checked with `pgrep` at the end).

---

## 0. Recommendations

| Question | Recommendation |
| --- | --- |
| VM tech | **Gondolin 0.14.0, krun backend by default, QEMU as fallback.** It is the only option with a host-programmable, per-request, runtime-toggleable, fully logged egress policy plus a Node API. Measured on this Mac: about 0.9 s to first exec and about 125 MiB runner RSS (krun), 0.5 to 0.8 s and about 280 MiB (QEMU). Runner-up: microsandbox 0.7.11 (memory snapshots, live fork, OCI images, Node SDK), but it is beta, I found no documented way to change policy while a VM runs, and I did not boot-test it. |
| Harness location | **On the host, in the Node backend.** Tool calls become `vm.exec` / just-bash `exec`. This removes the model bridge into the VM (the old setup's only allowed hole to the Mac), lets VM network be truly off, and gives one trace format for both env types. Keep "agent CLI inside the VM" as an optional, labeled mode later. |
| VM workspace visibility | **Keep `/workspace` on the guest root disk, not on a Gondolin VFS mount.** VFS is 300x to 450x slower for small files and is not included in checkpoints. Show changes with a root-owned observer in the guest that diffs a manifest before and after each tool call. Agent commands run as an unprivileged `agent` user, so the agent can't tamper with the observer. Use VFS `MemoryProvider` only for small host-owned exchange folders. |
| just-bash visibility | Wrap its `IFileSystem` in a recording proxy. The filesystem is a host object, so the diffs are exact and need no trust in the guest. Snapshot, fork, and reset are serialize/restore operations (34 ms / 3 ms for 1,205 paths). |
| just-bash isolation | **One child process per environment, launched under `sandbox-exec`** (no network, no file writes, no home-dir reads; verified working with Python). Network goes through a custom `fetch` that calls back to the backend's shared policy engine. If the built-in network option is ever used, **always set `denyPrivateRanges: true`**: without it, full-web mode reached a loopback server on the Mac. |
| App shell | Tauri 2.12 shell plus a **plain Node backend** (not compiled), launched as a bundled official `node` binary through `externalBin`, with backend JS and `node_modules` in `bundle.resources`. The UI talks to the backend over HTTP + WebSocket on 127.0.0.1 with a per-launch token. Tauri IPC is used only to hand the UI the URL and token. No launchd agent. |

---

## 1. VM technology

### 1.1 Comparison

| | Gondolin 0.14.0 | microsandbox 0.7.11 | Apple `container` 1.6.1 / Containerization 0.33.3 | Docker Sandboxes `sbx` 0.50.1 | Lima 2.2.1 | E2B self-host |
| --- | --- | --- | --- | --- | --- | --- |
| Released / activity | 0.14.0 on 2026-10-22, 0.13.0 on 2026-10-04 [V npm, GitHub] | 0.7.11 on 2026-10-24, 0.7.10 a day earlier [V GitHub] | container 1.6.1 on 2026-10-23; Containerization's last GitHub release is 0.33.3 prerelease (2026-06-01), repo pushed 2026-10-28 [V] | v0.50.1 on 2026-10-28 [V] | v2.2.1 on 2026-10-03 [V] | infra 2026.30 on 2026-09-10 [V] |
| Maturity | Pre-1.0, repo describes itself as "Experimental"; 2.3k stars; maintained by Armin Ronacher (mitsuhiko, 379 commits) [V] | "Beta, expect breaking changes" (README); 8.8k stars; 2 main authors [V] | Apple, 51k stars; 1.x CLI, 0.x Swift package [V] | Docker, closed binary, 481 stars on the releases repo [V] | CNCF, 22k stars [V] | 14.6k stars (SDK); infra needs Linux KVM [V stars, I KVM] |
| Isolation | Per-VM HVF via QEMU (`-nodefaults`, virtio only) or libkrun [V docs/security.md] | libkrun microVM [V README] | One lightweight VM per container (Virtualization.framework) [V docs/technical-overview.md] | microVM per sandbox [V Docker FAQ] | Full VM (VZ or QEMU) [I] | Firecracker [I] |
| Host-side egress policy | **Yes. Host userspace TCP/IP stack; HTTP replayed by host `fetch`; TLS MITM, so policy sees full HTTPS URL and method; per-request JS callbacks (`isRequestAllowed`, `isIpAllowed`, `onRequest`, `onResponse`); internal ranges blocked by default since 0.13; non-HTTP TCP dropped; UDP only DNS** [V docs + my test] | Yes: ordered rules (domain, CIDR, groups, ports); private/host/metadata blocked by default; strict hostname mode needs TLS interception [V docs/networking/overview.mdx] | **No** per-destination egress controls documented; vmnet NAT, containers reachable from host by IP [V docs/networking.md grep] | Allow/deny rules with presets; JSONL policy audit since v0.32 [V web, third-party] | No [I] | Cloud-style [I] |
| Toggle policy at runtime | **Yes.** Callbacks read live state; I switched off, registries, and web on one running VM [V experiment] | Not found in docs (searched for update/set policy) [I: set at create time] | n/a | Unknown | n/a | n/a |
| Log allowed + denied | **Yes**, every request in hooks (URL, method, resolved IPs, response status) [V experiment] | Deny responses documented; no SDK event stream found [I] | No | JSONL audit [V web] | No | ? |
| Host filesystem visibility | VFS: guest FUSE served by host JS providers (`MemoryProvider`, `RealFSProvider`, custom), with before/after hooks per op [V]; `vm.fs.*` read/list/stat any guest path [V] | Volumes / virtiofs-like mounts, fs SDK [V docs list] | virtiofs bind mounts (`--volume`) [V docs] | Shared paths [V FAQ] | Mounts | API |
| Snapshot / fork / reset | Disk-only qcow2 checkpoints; checkpointing closes the VM; resume many times via overlays [V docs]. Measured: checkpoint 45 ms (krun) / 71 ms (QEMU); 2 parallel forks to first exec 1.0 s (krun) / 4.0 s (QEMU) [V] | Disk and **full memory** snapshots, live `fork` [V docs] | `commit` / `export` to image or tar [V docs] | Not documented [V FAQ] | Lima snapshots (QEMU only) [I] | Pause/resume snapshots [I] |
| Boot to first exec | krun 0.89 to 0.92 s warm (1.49 s first); QEMU 0.48 to 0.77 s [V experiment] | Claims "fast" [unmeasured] | "Comparable to containers in a shared VM" [V docs, unmeasured] | ? | Tens of seconds [I] | ? |
| RAM per idle VM (1 GiB guest) | krun about 125 MiB, QEMU about 273 to 292 MiB runner RSS [V] | ? | "Only uses the memory the app needs"; freed pages not returned [V docs] | ? | High [I] | n/a |
| Programmatic API from Node | Native TS library, in-process [V] | NAPI SDK (Node 22+) [V docs] | CLI or Swift/XPC only; would need a Swift helper [V] | CLI only [V FAQ] | CLI | SDK, but server is Linux-only |
| Account / setup | None. QEMU from Homebrew; krun runner and libkrun 1.17.4 dylibs ship in the npm optional dependency [V] | Installer or npm | Signed .pkg install, needs a system service | **Docker sign-in required**; local creation failed without it on 2026-10-13 (`error: not signed in to Docker`) [V local_llms QA.md] | brew | Terraform/Nomad cluster |
| Fit for Terrarium | **Best** | Strong runner-up | Poor: no egress policy; Swift integration | Poor: account, CLI-only, agent-in-VM design | Poor | Not on macOS |

Why Gondolin wins:
- It is the only option where "package registries only", "full web", and "off" can be a JS function we toggle per environment while the VM runs. Its log shows full HTTPS URLs because Gondolin terminates TLS itself.
- The control plane is TypeScript in our own backend process, with no daemon and no account.

What it costs:
- Disk-only checkpoints. No RAM state; the VM must be closed to checkpoint, and resume is a cold boot (about 1 s).
- Only Alpine-built images, though OCI rootfs sources such as `debian:bookworm-slim` are supported via `oci.image` when Docker or Podman is available.
- No HTTP/2, HTTP/3, QUIC, or WebRTC.
- The krun backend is labeled experimental [V docs/limitations.md, backends.md].

### 1.2 Boot test (Gondolin 0.14.0, this Mac) [V]

Setup: the old local_llms guest image (Alpine 3.23, kernel 6.18.56-virt, rootfs 1.07 GB with Chromium/Node/Python/git), APFS-cloned into scratch so local_llms was untouched. Settings: `rootfs.mode: "memory"`, 1024 MiB, 2 vCPU, no VFS mounts. RSS was taken from `ps -o rss` on `vm.getHostPid()`.

| Backend | Run | create (ms) | start (ms) | first exec (ms) | total to first exec (ms) | runner RSS idle (MiB) | RSS after guest allocated and freed 200 MiB (MiB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| QEMU | 1 | 45 | 717 | 4 | 767 | 273.0 | 479.6 |
| QEMU | 2 | 1 | 474 | 3 | 478 | 292.5 | 501.5 |
| QEMU | 3 | 1 | 623 | 17 | 641 | 289.8 | 488.0 |
| krun | 1 | 324 | 1154 | 9 | 1488 | 124.8 | 339.2 |
| krun | 2 | 30 | 891 | 2 | 924 | 126.6 | 289.1 |
| krun | 3 | 27 | 843 | 19 | 889 | 126.4 | 341.1 |

- Host Node process RSS was 80 to 94 MiB with one VM [V].
- **Guest memory is not returned to macOS after the guest frees it** (both backends) [V]. Apple documents the same for Virtualization.framework [V apple/container docs/technical-overview.md]. Implications: keep guest RAM small (512 MiB to 1 GiB), and treat "reset" (reboot from checkpoint) as the memory-reclaim path. Gondolin 0.11 added `qemuIdlePauseMs` to pause idle QEMU VMs (CPU, not RAM) [V CHANGELOG].
- krun ran the libkrunfw kernel 6.12.68; QEMU ran the image's 6.18.56-virt [V]. The image built with 0.13 booted fine under the 0.14 host. The 0.14 `chmod` fix needs a rebuilt image [V CHANGELOG].
- Two simultaneous VMs (the fork test) worked on both backends [V].

### 1.3 Feature probes (Gondolin 0.14.0) [V, `features.mjs`]

Network policy, toggled at runtime on one VM via a closure (`policy.mode`):

| Probe | off | registries | web |
| --- | --- | --- | --- |
| https://pypi.org/simple/ | 403 | 200 | 200 |
| https://example.com/ | 403 | 403 | 200 |
| http://169.254.169.254/ (metadata) | 403 | 403 | 403 |
| http://192.168.1.1/ (LAN) | 403 | 403 | 403 |
| https://1.1.1.1/ (raw IP TLS) | fail | fail | fail |

The audit array captured every request with mode, method, and full URL (HTTPS included). It also captured each IP check with hostname and resolved IP (for example pypi.org resolved to `2a04:4e42:200::223`) and each response status.

VFS (guest FUSE served by host providers):
- Guest writes under a `RealFSProvider` dir appeared on the host immediately; `fs.watch` fired. `MemoryProvider` contents were readable from the host. VFS `after` hooks report every op (`lstat`, `open`, `read`, `release`, ...) with paths.
- **The guest can create a real host symlink with any target**: `/workspace/evil-abs -> /Users/karvi/.zshrc` appeared on the host as a symlink. The guest itself got ENOENT through it. A naive host reader that follows symlinks would leak that file.
- Hardlinks: `ln /etc/passwd /workspace/x` fails with EXDEV; hardlinks inside the workspace succeed. `mkfifo` is "Not supported". `..` escapes resolve inside the guest.

Throughput by storage location:

| Op | VFS RealFS | VFS Memory | guest rootfs |
| --- | --- | --- | --- |
| Create 1,000 small files (QEMU) | 7,498 ms | 6,133 ms | 23 ms |
| Create 1,000 small files (krun) | 6,943 ms | 4,428 ms | 16 ms |
| Write 64 MiB sequential (QEMU / krun) | 71 / 40 MB/s | - | 3.1 / 3.8 GB/s |
| 0.13.0 vs 0.14.0, krun Memory VFS: write 1,000 | 15,197 vs 6,922 ms | | 31 vs 37 ms |
| 0.13.0 vs 0.14.0, krun Memory VFS: read+stat 1,000 | 5,991 vs 7,917 ms | | 10 vs 17 ms |

That is about 6 to 7 ms per file operation over FUSE + virtio-serial RPC. An `npm install` writing 20k files would spend minutes on VFS (projection from 7 ms/file [I]).

Checkpoint and fork: checkpoint took 45 to 71 ms and produced a 74 MB qcow2 (it included a 64 MiB test file). Both forks resumed from it showed `base` plus only their own line, so they are independent.

Observability on a rootfs workspace (`observe.mjs`, krun):
- `adduser agent`; `su agent` commands run as uid 1000. The agent got "Permission denied" on root-owned `/var/lib/terrarium` (mode 0700).
- After the agent wrote 1,002 files: a manifest (`find -exec stat`, 1,004 entries) took **218 ms**; sha256 of 1,001 files took **601 ms**.
- Shadow git (GIT_DIR outside the workspace, root-only): first commit of 1,002 files 2.2 s; next commit 1.1 s; correct `--stat` and patch output.
- Node `fs.watch(recursive)` inside the guest was **unreliable**: 3 events in one run, 0 in another, for about 1,000 writes. Use `inotifywait -m -r` (add `inotify-tools` to the image) or a small helper binary if live events are needed [I for the fix].

### 1.4 Lessons from local_llms (read-only review)

How it was built [V files]:
- Gondolin 0.13.0, QEMU 11.1.2, custom Alpine 3.23.0 image from `config/guest-build.json`. Packages: linux-virt, bash, curl, git, nodejs, npm, python3, ripgrep, fd, chromium, nss, font-noto, e2fsprogs(-extra).
- Built with `gondolin build --config ... --output vendor/guest`. Result: rootfs 1.07 GB, initramfs 6.3 MB, plus krun kernel assets (krunfw v5.2.1) that were never used.
- Pi 1.2.0 + Playwright were installed into the VM at provision time (pnpm tarball copied in) and frozen into a "factory" checkpoint.

What worked [V QA.md, evidence/]:
- The host-enforced network policy: 16 live guest checks and 16 policy-unit checks passed. These covered private IPv4/IPv6, loopback, link-local, CGNAT, IPv4-mapped loopback, metadata, and DNS rebinding through `127.0.0.1.nip.io`.
- `httpHooks.onRequest` rewrote `http://model.local/v1` to a loopback inference gateway that validated the request schema: text only, ≤12 function tools, `max_tokens` clamped, thinking off, `store:false`.
- `vm.exec` streaming with `output()`; checkpoint per stop; APFS `clonefile` copies for clone/factory.
- Reusable as-is: `sandbox_policy.mjs` patterns (port/userinfo checks, deny logging), the gateway's `sanitize()` allowlist, and pinned-hash provenance manifests.

What was fragile or missing [V code + QA.md + reviews]:
1. **Workspace invisible**: files lived on the VM disk; the host only saw them through explicit 32 MiB import/export. This is the user's main complaint.
2. **Agent in VM**: Pi ran inside the VM (`pi -p --mode json` per turn). The host saw only Pi's own event stream, so there were no host-side records of commands, file changes, or raw model requests. It also forced the model bridge, the one place the policy had to allow a host loopback port (`allowedInternalHosts: ["127.0.0.1"]` plus port and path rules).
3. **Lifecycle complexity**: one global lock with PID files, an `active.json`, orphan-controller recovery, and startup model-selection races. Most P2 review findings were lifecycle races. Checkpoints happen only by closing the VM, so every save is a stop. Each save writes a new 285 to 300 MB qcow2 (2 kept per VM; about 1.6 GB under `state/instances`).
4. **Network log only recorded denials** (27 lines total in `logs/network.jsonl`); allowed traffic was not visible.
5. **Context bug**: 8K context minus Pi's fixed 4,096 reserve led to 1-token replies, which were marked "completed".
6. Boot time was never measured (now measured above).

---

## 2. Workspace visibility design

### 2.1 Options evaluated

| Option | Live tree | Per-call diff | Trust needed | Perf | Snapshot/fork | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| (a) Host-owned VFS mount (`MemoryProvider` or custom provider at `/workspace`) | Yes: host sees every op via provider + hooks | Yes, exact | **None** (host owns the bytes) | **300x to 450x slower** on small files [V] | **Not in checkpoints** [V docs]; fork needs a separate copy of provider state | Only for small exchange dirs |
| (a') `RealFSProvider` on a host dir | Yes (fs.watch) | Yes | Host must never follow guest-made links: guest plants arbitrary symlinks [V] | Same slowness [V] | Not in checkpoints | Avoid for the workspace |
| (b) Snapshot dir before/after each tool call (manifest + hashes) | Poll | Yes | Guest kernel + root observer | 218 ms stat + 601 ms hash for 1k files [V] | Workspace is on rootfs, so it is in checkpoints | **Use as ground truth** |
| (c) inotify in guest streamed out | Yes | No (events only) | Guest kernel + root observer | Cheap | n/a | Live hint only; Node `fs.watch` unreliable [V]; use `inotifywait` [I] |
| (d) git inside the workspace | No | Yes | Agent can see and tamper with `.git` | 1 to 2 s per commit at 1k files [V] | Fine | Only as **shadow git** (GIT_DIR outside the workspace, root-only) [V] |

### 2.2 Recommended design

VM environments:
1. `/workspace` lives on the guest root disk (qcow2 overlay). It is then included in checkpoints, fork, and reset, and runs at native speed. Heavy dirs (`node_modules`, `.venv`, caches) are listed but not content-hashed.
2. Each tool call executes as `agent` (uid 1000) via `su agent -s /bin/sh -c '...'` (busybox; Gondolin `exec` has no user option) [V]. Before and after, the backend runs a root-owned observer helper baked into the image.
   - The helper emits JSON: a manifest of `{path, type, size, mtime_ns, mode, nlink, ino, linkTarget}` plus sha256 for entries whose `(size, mtime, ino)` changed.
   - The backend fetches changed file contents with `vm.fs.readFile`, which resolves paths inside the guest, so a symlink to `/etc/shadow` only ever reaches the guest's own file.
   - Blobs go into a content-addressed store keyed by sha256, and the unified diff (jsdiff) goes into the trace (SQLite).
   - Cap blob size (for example 2 MiB) and mark binary or oversized files "changed, not captured".
3. Live tree while a command runs: poll the manifest at 1 Hz, or stream `inotifywait -m -r --format` output over a long-lived `vm.exec` pipe. The per-call manifest diff stays authoritative.
4. Shadow git (`GIT_DIR=/var/lib/terrarium/shadow.git`) is an acceptable shortcut for history and diffs if building the store takes too long; it measured 1 to 2 s per call at 1k files [V].
5. Exchange folders: `/inbox` (read-only `MemoryProvider` the host fills) and `/outbox` (`MemoryProvider` the host reads directly). These are host-owned and trustless, and small enough that VFS speed doesn't matter.
6. Host-side trustless signals to show beside the guest-reported ones: network log (host stack), runner RSS/CPU (`getHostPid()` + `ps`/`proc_pidinfo`), checkpoint sizes.

Residual risk: a guest kernel privilege escalation would let the agent become root in the guest and forge observer output. Mitigations: label the file tree as "reported by the guest observer"; for forensic checks, read the stopped checkpoint offline on the host (`qemu-img` + `debugfs` from Homebrew e2fsprogs) [I, not built].

just-bash environments:
- Its filesystem is a host-side `IFileSystem` object. Wrap it in a proxy that records every mutating call (`writeFile`, `appendFile`, `mkdir`, `rm`, `mv`, `cp`, `symlink`, `link`, `chmod`, `utimes`, `createExclusive`) with path and before/after hash, and streams events to the backend over IPC.
- Diffs are exact and the tree is live with no trust issue. Snapshot by serializing `getAllPaths()` + `lstat` + `readFileBuffer`/`readlink` (measured below). The `trace` callback emitted no events for ordinary commands [V], so don't rely on it.

Link-attack rules (both types):
- Never let the host follow a guest-controlled path on the host filesystem.
- If a `RealFSProvider` is ever used, host reads must `lstat` + open with `O_NOFOLLOW`, and must reject symlinks, `nlink > 1`, and non-regular files.
- Exports are copies into an app-owned dir, written with `wx` flags, never executed or auto-opened.

---

## 3. just-bash

Version and API [V npm, package README/CHANGELOG, 2026-10-28]:
- `just-bash` 3.6.0 (2026-10-01; previous 3.4.2 on 2026-08-22). Repo vercel-labs/just-bash, 4.4k stars, pushed 2026-10-27, main author Malte Ubl (cramforce). README says "beta software".
- API: `new Bash({ fs, cwd, env, files, python, javascript, network, fetch, executionLimits, executionLimitProfile, defenseInDepth, customCommands, logger, trace })` and `await bash.exec(script, { cwd, env, stdin, signal, args })` returning `{stdout, stderr, exitCode}`.
- Shell state resets per `exec`; the filesystem persists.
- Filesystems: `InMemoryFs`, `OverlayFs` (copy-on-write over a real dir), `ReadWriteFs` (real dir), `MountableFs`.

Measured (`jb.mjs`, Node 24.18) [V]:

| Probe | Result |
| --- | --- |
| Construct `Bash` | 20 ms |
| Simple command | 30 ms; `uname`, `id` not found; `/etc/passwd` absent; `/` = bin, dev, proc, usr, workspace |
| Python | 3.13.2 on Emscripten (WASM in a worker): cold 631 ms, warm 394 ms. No `subprocess` (errno 138), no sockets, **no pip, no numpy**, `urllib` https unsupported |
| JS (`js-exec`, QuickJS) | 169 ms; `child_process.execSync` maps to the virtual shell; host fs invisible; `Function` constructor blocked |
| Network unset | `curl: command not found` |
| Allow-list `https://pypi.org/simple/` | pypi 200; example.com blocked |
| **`dangerouslyAllowFullInternetAccess` without `denyPrivateRanges`** | **Reached a loopback HTTP server on the Mac (`CANARY_HIT`)** |
| Same with `denyPrivateRanges: true` | Loopback and `127.0.0.1.nip.io` blocked; example.com 200 |
| Serialize 1,205 paths | 34 ms, 75 KB JSON; restore 3 ms; fork independent |
| 1,000-file `cat` | 16 ms |
| Backend RSS | 75 MiB before, **294 MiB after Python + JS loaded** (not near-zero once runtimes are enabled) |

Answers:
- **Serialize, snapshot, restore**: no built-in snapshot API. The recipe above works and is fast [V]. Store snapshots as content-addressed blobs plus a path index so forks share data.
- **Network allow-lists**: URL-prefix + method allow-lists (GET/HEAD by default), redirect re-checks, header-injection transforms, and `denyPrivateRanges` (default **false**) with DNS pinning [V types.d.ts + test]. Policy is a constructor option. Since shell state resets per `exec`, building a new `Bash` per tool call over the same `fs` toggles policy at 20 ms cost [V]. Better: pass a custom `fetch` that RPCs to the backend's shared policy engine, so VM and just-bash share one policy module and one log.
- **Python/JS limits**: pure-Python stdlib only; no native wheels, no processes, no sockets. QuickJS JS has a 64 MB memory limit and 30 s (normal) or 10 s (hardened) timeouts [V README]. Fine for "simulated" environments, not for real work.
- **Where to run it**: **not in the backend process.** The README says execution happens "without VM isolation". Its defense-in-depth is "scoped best-effort". Node worker `resourceLimits` "do not reliably cap the WebAssembly linear memory used by CPython or sql.js" [V README]. A hang or OOM in one environment should not take down the harness, the trace store, and running VMs. Use one child process per environment (cheap; only 1 or 2 run at once).
- **Defense in depth, verified**: the child ran under `/usr/bin/sandbox-exec -f sbx/jb.sb` with this profile: `(allow default) (deny network*) (deny file-write*)`, home-dir reads denied except the app code dir and the Node install. just-bash + Python ran normally; reading `~/.zshrc` gave EPERM, writing `/tmp` gave EPERM, `fetch` gave ENOTFOUND [V].
  - `sandbox-exec` is deprecated but present and working on macOS 27 [V].
  - Also: `executionLimitProfile: "hardened"`, `defenseInDepth: { enabled: "auto" }`, `InMemoryFs({ maxTotalBytes })`, `--max-old-space-size`, `python`/`javascript` only when the env asks for them, and never `ReadWriteFs`/`OverlayFs` over host dirs.
  - Node's `--permission` model is a possible extra layer (needs `--allow-worker` for Python) [I, untested].

---

## 4. Tauri v2 + Node backend

### 4.1 Packaging options

| Option | Verdict | Why |
| --- | --- | --- |
| **Bundled official `node` binary as `externalBin` + backend `dist/` + prod `node_modules` in `bundle.resources`** | **Recommended** | Zero runtime-compat risk. Gondolin's krun runner (bin + `lib/libkrun.1.dylib` via `@loader_path/../lib`) and just-bash's `vendor/cpython-emscripten/python.wasm` + worker chunks must exist as real files anyway [V]. The cost is app size (Node binary roughly 100+ MB [I]), which doesn't matter for one Mac. |
| Node SEA | No | Node 24 still needs `--experimental-sea-config` + postject (last release 1.0.0-alpha.6, 2023) [V]. Node 25.5 added `--build-sea`; ESM entry via `mainFormat` landed around Feb 2026 [V web, third-party date]. Native addons and on-disk assets still need extraction. |
| `bun build --compile` | No | Bun not installed; Gondolin needed a Bun-specific MITM fix in 0.13 [V CHANGELOG], so Node-compat drift is a known risk. |
| `deno compile` | No | Deno 2.9.7 installed [V] but npm/worker/WASM paths are untested here [I]. |
| launchd LaunchAgent + app connects | Not now | Survives UI quit, but adds install/uninstall and a background footprint the user rejected last time ("Nothing starts at login" was a stated property of local_llms). Keep the backend standalone-runnable so switching later is trivial. |

### 4.2 Runtime wiring

- Rust `setup` spawns `Contents/MacOS/node Contents/Resources/backend/main.js` with `std::process::Command` (no shell plugin needed). It passes a random 256-bit token via env and reads one handshake line `{"port":N}` from stdout (backend binds 127.0.0.1:0).
- On `RunEvent::Exit`, Rust sends SIGTERM. The backend also exits on stdin EOF, so VMs never outlive a crashed shell; local_llms needed orphan-recovery code for exactly this.
- Closing the window hides it (agents keep running); Quit stops everything.
- UI ↔ backend: plain `fetch` for commands, **one WebSocket** for the event firehose (tokens, tool stdout/stderr chunks, fs events, network log, resource samples). The only Tauri command is `backend_info() -> {url, token}`.
- Why not Tauri IPC/Channels for data: every event would hop Node → Rust → WebView. WebSocket goes Node → WebView directly. A Unix socket would also need a Rust proxy because WKWebView `fetch` can't speak UDS [I].
- Backend checks on every request:
  - Exact `Host` (`127.0.0.1:N`): blocks DNS rebinding from browser tabs.
  - `Origin` allowlist: `tauri://localhost` in prod, `http://localhost:5173` in dev.
  - Bearer token on HTTP; token as WebSocket subprotocol or first message.
  - Body size caps.
- CSP: `connect-src http://127.0.0.1:* ws://127.0.0.1:*`.
- Dev workflow:
  - pnpm workspace: `apps/ui` (Vite), `apps/backend` (TS, run directly with Node 24's type stripping, or `tsx`), `src-tauri`.
  - `tauri.conf.json`: `build.devUrl = "http://localhost:5173"`, `beforeDevCommand = "pnpm -r --parallel dev"`.
  - In dev, the backend runs from the dev script on a fixed port; the Rust shell detects `TERRARIUM_BACKEND_URL` and skips spawning.
  - The UI also works in a normal browser against the same backend for debugging.
- Signing for this Mac: `bundle.macOS.signingIdentity: "-"` (ad-hoc) [V Tauri docs]. Locally built apps are not quarantined, so no Gatekeeper prompt is expected [I].
  - **Gotcha**: VM runner binaries need `com.apple.security.hypervisor`. The Gondolin krun runner (ad-hoc signed) and Homebrew QEMU both carry it [V `codesign -d --entitlements -`].
  - If the bundler re-signs resources, re-apply that entitlement and verify after `tauri build` [I].
  - The app cannot use App Sandbox, since it spawns a VMM and a Node runtime [I].
- pnpm 12 note: installing gondolin + just-bash printed `ERR_PNPM_IGNORED_BUILDS` (ssh2, cpu-features, @mongodb-js/zstd, node-liblzma) but still installed the packages. Those native builds are optional. Set `onlyBuiltDependencies`/`allowBuilds` explicitly to make it quiet [V].

### 4.3 Install commands (pinned; not run)

Versions checked 2026-10-28:
- @tauri-apps/cli 2.12.4 (2026-10-21), @tauri-apps/api 2.12.4.
- tauri crate 2.12.5, tauri-build 2.7.4.
- create-tauri-app 4.7.5.
- tauri-plugin-shell 2.6.0 came out today (2.5.0 on 2026-10-10); not needed with `std::process`.
- Node: 24.22.2 (2026-10-27) is the newest 24.x. 26.13.0 became LTS today.

```
# repo root (pnpm workspace)
pnpm add -D -w @tauri-apps/cli@2.12.4
pnpm add --filter ui @tauri-apps/api@2.12.4
pnpm add --filter backend @earendil-works/gondolin@0.14.0 just-bash@3.6.0
pnpm tauri init        # creates src-tauri in the existing Vite project

# alternative: Rust-native CLI instead of the npm one
cargo install tauri-cli --version 2.12.4 --locked

# src-tauri/Cargo.toml
#   [build-dependencies] tauri-build = "=2.7.4"
#   [dependencies]       tauri = { version = "=2.12.5", features = [] }

# sidecar Node binary (match the dev Node major), verified against the release checksums
curl -fsSLO https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz
curl -fsSLO https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
shasum -a 256 -c --ignore-missing SHASUMS256.txt
# then copy node-v24.22.2-darwin-arm64/bin/node to src-tauri/binaries/node-aarch64-apple-darwin
# tauri.conf.json: "bundle": { "externalBin": ["binaries/node"], "resources": { "../apps/backend/dist": "backend" } }

# guest image tooling (for gondolin build)
brew install lz4 e2fsprogs
```

---

## 5. Security

Threat model: a possibly adversarial small model with arbitrary command execution in the environment, trying to read Mac files or credentials, reach the Mac/LAN/loopback (oMLX on 8010, other dev servers), exfiltrate, persist, or exhaust resources. Host Node backend = trusted; guest = untrusted.

### 5.1 VM environments (Gondolin)

| Control | Detail | Status |
| --- | --- | --- |
| Hypervisor boundary | HVF via libkrun or QEMU (`-nodefaults`, virtio-only). Keep QEMU current; a VMM escape is a host compromise (Gondolin non-goal) | [V docs] |
| No host mounts | `vfs.mounts` only `MemoryProvider` exchange dirs; never `RealFSProvider` on host paths for the workspace | [V behavior] |
| No model bridge | Harness on host, so **no** `allowedInternalHosts` and no host-port exception at all | design |
| Egress policy | `off`: `isRequestAllowed` false. `registries`: exact hosts (pypi.org, files.pythonhosted.org, registry.npmjs.org, github.com, codeload.github.com, objects.githubusercontent.com, release-assets.githubusercontent.com, raw.githubusercontent.com, dl-cdn.alpinelinux.org), **GET/HEAD only**. `web`: public HTTP/HTTPS. Internal ranges are blocked in all modes by `createHttpHooks` (default `blockInternalRanges`) and the DNS-rebinding connect-time guard. `allowWebSockets:false`, `dns:"synthetic"`, no `tcp.hosts`, no SSH egress, body caps | [V test; host list I] |
| Exfil reality | Allowed hosts can receive anything the guest can read (Gondolin docs). GET-only registry mode limits this to URL/query data | [V docs] |
| Logging | Every request decision + IP check + response status to the trace store, shown live | [V test] |
| Secrets | None in the guest; `env` explicit (old setup cleared provider auth); per-env `mitmCertDir` in an app dir (docs recommend; default `~/.cache/gondolin/ssl` is shared by all VMs) | [V docs] |
| Guest privilege split | Agent commands as uid 1000; observer and its state root-only (0700) | [V test] |
| Resource limits | VM `memory` (512 MiB to 1 GiB), `cpus`, `rootfs.size`, per-exec `AbortSignal` timeouts, host-side stdout/stderr truncation, max 1 to 2 running VMs, `qemuIdlePauseMs` | [V options; limits I] |
| Local sockets | `GONDOLIN_SESSIONS_DIR` and image store in a 0700 app-support dir (same-user local attacker is a Gondolin non-goal) | [V docs] |
| Host never follows guest paths | Content via `vm.fs` / providers only; exports copied with `wx`, never executed or opened; UI renders model and tool text escaped, no raw HTML, strict CSP (kept from the old dashboard) | design |
| Optional hardening | Wrap the VMM in a `sandbox-exec` profile through a `qemuPath`/`krunRunnerPath` wrapper (file access limited to image + overlays + sockets) | [I, untested with HVF] |

### 5.2 just-bash environments

| Control | Detail | Status |
| --- | --- | --- |
| Process isolation | One child process per env, JSON over stdio, bounded message sizes; kill on timeout | design |
| OS sandbox | `sandbox-exec`: deny network, deny all file writes, deny home reads except app code + Node | [V test] |
| Filesystem | `InMemoryFs` with `maxTotalBytes`; never `ReadWriteFs`/`OverlayFs` over host dirs | [V API] |
| Network | No `network` option in the child; custom `fetch` → backend policy engine (same as VMs). If built-in network is used: `denyPrivateRanges: true` always | [V canary test] |
| Limits | `executionLimitProfile:"hardened"`, `maxExecutionTimeMs`, `maxOutputSize`, `--max-old-space-size`; python/js only on request | [V README] |
| Labeling | UI says "Simulated (just-bash): not a real OS; no pip, no native binaries" | design |

### 5.3 Host-side gaps found in local_llms (do not repeat)

1. **oMLX's native code benchmarks ran model-generated Python on the Mac.** HumanEval, MBPP, and LiveCodeBench used host subprocesses; this was missed by the initial 42 checks and found on 2026-10-15. The fix: reject those requests in a wrapper, replace the execution helpers with `PermissionError`, disable the cards. Terrarium rules:
   - Every eval that executes model output goes through the environment abstraction.
   - Don't expose oMLX's admin/benchmark UI from the app.
   - Keep oMLX on loopback with a key.
   - Keep the wrapper that blocks oMLX's native web-search, web-fetch, MCP, and code-execution routes, or verify the oMLX version lacks them [V QA.md, README].
2. Grader shared the interpreter with candidate code: adversarial candidates could tamper with scoring (accepted as "benchmark integrity, not host safety"). Run graders in a separate process as a different uid from the candidate [V review].
3. Network log recorded denials only; allowed traffic was invisible [V logs].
4. Lifecycle races (model switch during startup, orphaned controllers, cross-instance resets) produced most review findings. Keep one env-manager state machine in the backend, with VMs as child processes that die with it [V reviews].
5. Truncated replies were labeled "completed" (`stopReason: length`, 1 token) [V QA.md]. Always surface `finish_reason` and context usage.

---

## 6. Recommended architecture

```
+----------------------------------- Mac (trusted host) -----------------------------------+
|                                                                                          |
|  Tauri 2 app (Rust shell + WKWebView UI)                                                 |
|   - spawns/kills backend, hands UI {url, token} via one IPC command                      |
|   - UI <== HTTP + WebSocket (127.0.0.1:port, token, Host/Origin checks) ==> backend      |
|                                                                                          |
|  Node 24 backend (bundled node binary, plain JS)                                         |
|   +-- Harness runner: agent loop, tool router, context accounting ---- OpenAI API ----+  |
|   +-- Env manager: create / reset / fork / snapshot, max 1-2 running VMs              |  |
|   +-- Policy engine: off | registries (GET/HEAD) | web; internal ranges always denied |  |
|   +-- Trace store (SQLite + blob store): model req/resp, tool calls, stdout/stderr,   |  |
|   |     exit, duration, fs diffs, network log, resource samples                       |  |
|   +-- Observer: per-call manifest diff, live tree                                     |  |
|          |                                         |                                  |  |
|          | Gondolin SDK (in-process)               | child_process + JSON stdio       |  |
|          v                                         v                                  v  |
|  +--------------------------------+   +-------------------------------+   +----------+ |
|  | krun runner / QEMU (HVF)       |   | just-bash worker (per env)    |   | oMLX     | |
|  |  Linux microVM (Alpine/OCI)    |   |  under sandbox-exec:          |   | :8010    | |
|  |  sandboxd (root): runs tools   |   |  no net, no writes, no ~ read |   | loopback | |
|  |   as uid 1000 "agent"          |   |  InMemoryFs (recording proxy) |   | + key    | |
|  |  /workspace on rootfs qcow2    |   |  python wasm / quickjs opt-in |   +----------+ |
|  |  observer helper (root, 0700)  |   |  fetch -> IPC -> policy       |                |
|  |  /inbox /outbox = MemoryProv.  |   +-------------------------------+                |
|  |  eth0 -> host userspace stack -> httpHooks policy -> public internet only           |
|  +--------------------------------+                                                    |
|  Checkpoints: qcow2 per env (factory, named snapshots); fork = resume overlay          |
+------------------------------------------------------------------------------------------+
```

Open items for the build phase:
- Rebuild the guest image with Gondolin 0.14 (chmod fix): add `inotify-tools`, an `agent` user, and the observer helper. Consider an OCI Debian base for glibc wheels (needs Docker/Podman at build time; Colima is installed but stopped) [V docs, I need].
- Decide whether Chromium stays in the base image (the 1.07 GB rootfs is mostly Chromium [I]).
- Boot-test microsandbox before committing, if full-memory snapshots matter.

## Sources (checked 2026-10-28)

- Gondolin repo, docs, and CHANGELOG at commit 6b381a9 (v0.14.0, 2026-10-22): https://github.com/earendil-works/gondolin ; npm `@earendil-works/gondolin`
- just-bash 3.6.0 package README/CHANGELOG/types: https://github.com/vercel-labs/just-bash ; npm `just-bash`
- apple/container docs at HEAD (1.6.1, 2026-10-23): https://github.com/apple/container ; https://github.com/apple/containerization
- microsandbox docs at commit 8ff916f (2026-10-28): https://github.com/superradcompany/microsandbox
- Docker Sandboxes FAQ (undated page): https://docs.docker.com/ai/sandboxes/faq/ ; releases https://github.com/docker/sbx-releases
- Lima, libkrun, krunvm, E2B release metadata via `gh` (dates in table)
- Tauri docs (sidecar, macOS signing, Vite): https://github.com/tauri-apps/tauri-docs (v2 branch); versions from npm and crates.io
- Node SEA: https://nodejs.org/en/blog/release/v25.5.0 ; nodejs/node PR #61813 (ESM `mainFormat`)
- local_llms: README.md, QA.md, scripts/sandbox*.mjs, scripts/dashboard_vm.mjs, scripts/inference_gateway.py, config/*.json, evidence/*-security-review.md, logs/network.jsonl (read only)
