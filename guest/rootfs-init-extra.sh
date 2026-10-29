# Terrarium guest setup, appended by `gondolin build` to /init right before sandboxd starts.
# Runs as root on every boot (resume is a cold boot), so it must be idempotent and must never fail:
# /init runs with `set -eu`.
terrarium_setup() {
  if ! grep -q '^agent:' /etc/passwd; then
    addgroup -g 1000 agent
    adduser -D -u 1000 -G agent -h /home/agent -s /bin/bash -g agent agent
  fi
  # Locked root password: nothing in the guest can `su` to root.
  sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow
  mkdir -p /workspace /home/agent
  chown agent:agent /workspace /home/agent
  chmod 0755 /workspace /home/agent
  mkdir -p /var/lib/terrarium /run/terrarium/exec /run/terrarium/xfer
  chown root:root /var/lib/terrarium /run/terrarium /run/terrarium/exec /run/terrarium/xfer
  chmod 0700 /var/lib/terrarium /run/terrarium /run/terrarium/exec /run/terrarium/xfer
  chown -R root:root /usr/local/libexec/terrarium
  chmod 0755 /usr/local/libexec/terrarium
  chmod 0755 /usr/local/libexec/terrarium/run /usr/local/libexec/terrarium/kill /usr/local/libexec/terrarium/put
  chmod 0644 /usr/local/libexec/terrarium/observer.py
  # Write dirty pages within ~2 s, so a host crash or kill loses little of the root disk.
  echo 200 > /proc/sys/vm/dirty_expire_centisecs
  echo 100 > /proc/sys/vm/dirty_writeback_centisecs
  # pip as agent installs to ~/.local instead of failing on PEP 668.
  rm -f /usr/lib/python3*/EXTERNALLY-MANAGED
}
(set +e; terrarium_setup) > /dev/null 2>&1 || true
