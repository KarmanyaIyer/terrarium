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
    type `tests`). As root it kills every agent process and, before any candidate code runs, copies the
    workspace three times into a job dir: `src` (root-owned, read-only, symlinks removed and never
    followed; what the hidden tests read as the candidate's source, via `terrarium_grading.workspace`),
    `ws` (agent-owned; the isolated run) and `plain/ws` (agent-owned, in a root-only dir until the plain
    run). Then two runs of up to `--timeout` each:
    - Isolated: the candidate's code in a worker as `agent` in `ws`, the hidden tests in a runner as
      `grader` (`python3 -B -s -S -P`, cwd `src`), connected by a socketpair, both with one random
      `PYTHONHASHSEED`. Details below.
    - Plain: once the isolated run's processes are dead and its counts read (its `ws` and results are
      deleted), `grade_runner.py --plain` as `agent` in `plain/ws` with a copy of the tests: ordinary
      in-process unittest, exact Python semantics. Candidate code can forge these counts, so this run
      never passes on its own. Every agent process is killed afterwards.
    - Verdict: pass only when both runs counted passed == expected > 0; both failing is a fail; runs that
      disagree are `"verdict": "disagree"`, which the backend shows as a grader error (never a pass) with
      both runs' counts and failures. The summary is the isolated run's fields plus `plain` and `verdict`.

    The isolated run:
    - Rule: it never reports a pass that the same tests would not give the same code in one process.
      Where it can reproduce Python exactly it answers; where it can't, it raises `Inexact`, a grader
      error. Grader errors (`GraderError`: `Inexact`, a candidate process gone or hung, a value that can't
      cross) are not `Exception` subclasses, so `assertRaises` never counts them. A forged plain run can
      therefore turn a fail into a disagreement, never into a pass.
    - Values: None, bools, ints of any size, floats, strings, bytes, complex, Decimal, Fraction, datetime
      types, ranges and slices cross by value; tuples, frozensets and namedtuples by value with their
      sharing (one object met twice in a message arrives as one, so `[[0] * 3] * 2` keeps its shared rows
      and one NaN stays one NaN). Everything else crosses as a reference: a candidate object is a proxy on
      the test side, a test object a handle on the candidate side (using it calls back into the tests).
    - Containers: lists, dicts (OrderedDict, defaultdict with its factory, Counter), sets and bytearrays
      are linked both ways, whichever side made them, returned ones too (`store.get().append(9)` changes
      the candidate's own list). Before each message a side sends the new contents of every link its code
      could have changed that the other side's code can reach (a shallow identity check per link; lists by
      a memcmp of their element pointers). Holding is measured by reference count: a link is held when
      something besides the bookkeeping refers to it, or a held link holds it. New links are re-measured
      at every message, links both sides hold about 64 per message, the rest about 8 per message.
    - Candidate classes: each gets a stand-in class with the candidate's MRO, standard-library bases real
      where their layout allows, so `type(x) is m.Cls`, `isinstance`, `issubclass` and ABCs registered
      with `register()` answer as in one process. Special methods the class defines run in the candidate
      (`with m.Timer() as t` works). An object built on a data type (list, dict, str, int, tuple
      subclasses, IntEnum members) is a hybrid: its data is local (linked when mutable), the class's own
      methods run in the candidate. Module attributes set or deleted on a candidate module reach the
      candidate's module (`mock.patch.object(m, ...)`); `mock.patch` of a standard-library module or class
      is applied in the candidate process too.
    - Comparisons: two candidate objects are compared by the candidate. Between a candidate object and a
      test value, the candidate's `__eq__`, `__ne__` or ordering method counts only when its answer is the
      one comparing the data gives (no data: the identity fallback, `==` False, `!=` True); otherwise
      `Inexact`. Hashes are the candidate's, computed with the shared hash seed.
    - Exceptions: built-in and standard-library exception classes arrive as real exceptions (args,
      attributes, cause and context); candidate exception classes as stand-ins of the candidate's object
      (`cm.exception.code` reads the candidate's attribute).
    - Process state is mirrored where candidate code could see or change it: `sys.stdout`/`stderr` (the
      original, a `StringIO` capture such as `redirect_stdout`, or `print`/`input` replaced), `sys.stdin`
      text, `sys.argv`, the environment, the working directory, the `random` module's state, the `decimal`
      context (precision, rounding, flags, traps), the recursion limit, and the `warnings` filters both
      ways plus the tests' `showwarning` hooks (`assertWarns`, `catch_warnings(record=True)` and
      `simplefilter("error")` see the candidate's warnings). A stream the grader can't mirror (some other
      object) is a grader error when candidate code uses it. `assertLogs`/`assertNoLogs` are a grader
      error: logging isn't mirrored.
    - Stack depth: each side runs the other's requests padded to the depth one process would have them at
      (the other side's code frames stand in for the grader's), so a recursion runs out of stack where it
      would in one process. Through callback chains (candidate code calling a test callback that calls the
      candidate again) it runs out about 5 frames per hop sooner: stricter, never later.
    - Threads: test threads take turns calling candidate code, one call at a time (one of the schedules
      one process allows). Candidate code that touches a test object, writes output or changes a linked
      container after its call returned (a thread of its own) is a grader error, checked between tests.
    - One candidate call may use the whole `--timeout`; a call still running near the end fails, and the
      counts are still written. Syncing may use a quarter of the budget (5-30 s); past that the candidate
      counts as gone.
    - Visible grader errors that remain (never passes): pickling a candidate object; deep-copying a
      structure that holds candidate objects (the object alone works); a test class deriving from a
      candidate class; `isinstance` or `__class__` of an object whose class derives from a
      standard-library class the grader can't mirror; a candidate comparison that disagrees with the
      data; tests that keep more linked containers than the sync limit allows (12,000 containers held by
      both sides through 6,000 calls); candidate threads as above; `assertLogs`/`assertNoLogs`; candidate
      code replacing `warnings.showwarning`.
    - Known gaps (wrong answers, not errors; each needs a test asserting something unusual):
      `type(x)` of a candidate function, generator, module or other built-in non-data object is the
      grader's stand-in class, so `type(m.f) is types.FunctionType` is False (`isinstance` is right);
      logging configuration and handlers are per process (a handler the tests add to the candidate's
      logger sees nothing); standard-library state changed without `mock.patch` (assigning
      `json.dumps = ...`, `mock.patch.dict(sys.modules, ...)`, `locale.setlocale`, `time.tzset`) stays in
      the process that changed it. A test asserting the opposite of what one process does there could
      pass the isolated run where Python fails it.
    - Cost: about 70 us per call on an M-series Mac (one round trip; the plain run's call is about 0.1
      us). 5,000 calls returning a list each grade in 1 s; 6,000 records kept by the candidate in 1.5 s; a
      binary search over a 1M-element list, 300 calls, in 0.8 s.
    - The runner writes its counts to a dir only `grader` can write; pass means the runner exited 0 and
      passed == expected > 0 there. Failures beyond the first 50 are counted in `moreFailures`.
      Candidate exits, `sys.exit`, forged results files, rewriting the source after the copy (directly or
      through a symlink) and leftover daemons can't make the isolated run pass. Patching `unittest` or
      forging counts reaches only the plain run, which then disagrees with a failing isolated run (a
      grader error, not a pass).
  - `grade.py --command <cmd>`: eval check type `command` in a VM. As root it kills every agent and
    grader process, then runs `bash -c <cmd>` as `agent` in `/workspace` with
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` and a fresh empty `HOME`, so
    nothing the agent planted in `~/.local/bin` or its dotfiles runs. It never runs as root or as
    `grader`, so it can't read `/grader` (the validator rejects command checks that mention `/grader`
    or have hidden files). Pass on exit 0 within 170 s; a command that runs the agent's code can be
    cheated by that code, so hidden tests belong in a `tests` check.
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
