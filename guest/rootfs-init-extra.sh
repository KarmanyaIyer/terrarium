# Terrarium guest setup, appended by `gondolin build` to /init right before sandboxd starts.
# Runs as root on every boot (resume is a cold boot), so it must be idempotent and must never fail:
# /init runs with `set -eu`. The steps live in the setup helper so the host driver can rerun them on
# envs made from older images after updating their helpers.
(set +e; /bin/sh /usr/local/libexec/terrarium/setup) > /dev/null 2>&1 || true
