#!/bin/sh
# Rerunnable verification for the VM env: policy unit tests, then the VM integration tests (boots real
# VMs, at most 2 at once, 1 GiB each). Results: $TERRARIUM_DATA/vm-verify/latest.json.
# usage: guest/verify.sh [--policy-only]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
backend="$here/../apps/backend"
cd "$backend"
node --test src/policy/index.test.ts src/envs/vm/net.test.ts
[ "${1:-}" = "--policy-only" ] && exit 0
TERRARIUM_VM_TESTS=1 node --test --test-reporter=spec src/envs/vm/vm.test.ts
# The tests destroy their VMs; anything left is either a leak or another process's VM.
leftover=$(pgrep -f "gondolin-krun-runner|qemu-system-aarch64" || true)
[ -z "$leftover" ] || echo "warning: VMM processes still running (pids: $leftover)" >&2
echo "results: ${TERRARIUM_DATA:-$(cd "$here/.." && pwd)/data}/vm-verify/latest.json"
