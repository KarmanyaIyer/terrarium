// VmNetwork unit tests: logging paths that don't need a VM (debug lines, stack events, pending records).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { NetAttempt } from "../types.ts";
import { VmNetwork } from "./net.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withLog(mode: "off" | "registries" | "web" = "web") {
  const net = new VmNetwork(mode, async () => ["93.184.215.14"]);
  const log: NetAttempt[] = [];
  net.onAttempt((a) => log.push(a));
  return { net, log };
}

test("dropped raw TCP and UDP from debug lines are logged as denies", () => {
  const { net, log } = withLog();
  net.onDebug("tcp blocked 192.168.127.3:40000 -> 10.0.0.5:5432 (ssh)");
  net.onDebug("udp blocked 192.168.127.3:40001 -> 8.8.8.8:123");
  net.onDebug("dns synthetic 192.168.127.3:51826 -> 192.168.127.1:53 (79 bytes)");
  net.close();
  assert.deepEqual(
    log.map((e) => [e.decision, e.method, e.url, e.ip]),
    [
      ["deny", "SSH", "tcp://10.0.0.5:5432", "10.0.0.5"],
      ["deny", "UDP", "udp://8.8.8.8:123", "8.8.8.8"],
    ],
  );
});

test("TLS to a bare IP is logged once its handshake can't complete; SNI'd and hostname TLS are not", async () => {
  const { net, log } = withLog();
  net.onDebug("tls mitm start 192.0.2.1:443"); // hostname connection (synthetic DNS answer)
  net.onDebug("tls mitm start 10.0.0.1:443"); // bare IP, no SNI
  net.onDebug("tls sni example.com"); // belongs to the hostname connection
  net.onDebug("tls mitm start 10.0.0.2:443");
  net.onDebug("tls sni forced.example (pre-parsed)"); // client set SNI itself: its request gets logged
  await wait(2_300);
  net.close();
  assert.equal(log.length, 1, JSON.stringify(log));
  assert.equal(log[0]!.decision, "deny");
  assert.equal(log[0]!.ip, "10.0.0.1");
  assert.match(log[0]!.reason, /TLS to bare IP 10\.0\.0\.1/);
});

test("tcp-deny stack events are logged, including after the stack is recreated", () => {
  const { net, log } = withLog();
  const backend = {
    stack: new EventEmitter(),
    resetStack() {
      this.stack = new EventEmitter();
    },
  };
  assert.equal(net.watchStack({ server: { network: backend } }), true);
  backend.stack.emit("tcp-deny", { key: "TCP:192.168.127.3:40000:192.168.127.1:6379", reason: "unknown-protocol" });
  backend.resetStack();
  backend.stack.emit("tcp-deny", { key: "TCP:192.168.127.3:40002:1.1.1.1:443", reason: "connect-not-allowed" });
  backend.stack.emit("tcp-deny", { key: "TCP:192.168.127.3:40003:1.1.1.1:22", reason: "policy-deny" }); // has its own debug line
  net.close();
  assert.deepEqual(
    log.map((e) => [e.method, e.url, e.reason]),
    [
      ["TCP", "tcp://192.168.127.1:6379", "non-HTTP TCP dropped: only HTTP and HTTPS are proxied"],
      ["CONNECT", "tcp://1.1.1.1:443", "HTTP CONNECT (proxy tunnel) not allowed"],
    ],
  );
  assert.equal(net.watchStack({}), false);
});

test("an allowed request is logged once even when the hook and the fetch spell its URL differently", async () => {
  const { net, log } = withLog("web");
  assert.equal(await net.httpHooks.isRequestAllowed!({ method: "GET", url: "http://Example.COM", headers: {} } as never), true);
  net.mode = "off"; // switched before the upstream hop: denied there, nothing sent
  await assert.rejects(net.fetch("http://example.com/", { method: "GET", redirect: "manual" }), /mode off/);
  net.close(); // would flush an unmatched pending record as "never sent upstream"
  assert.deepEqual(
    log.map((e) => [e.decision, e.reason]),
    [["deny", "mode off"]],
  );
});

test("hook denies carry the policy reason and the offending IP", async () => {
  const net = new VmNetwork("web", async () => ["93.184.215.14", "10.1.2.3"]);
  const log: NetAttempt[] = [];
  net.onAttempt((a) => log.push(a));
  assert.equal(await net.httpHooks.isRequestAllowed!({ method: "GET", url: "https://mixed.example/", headers: {} } as never), false);
  net.close();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.ip, "10.1.2.3");
  assert.equal(log[0]!.reason, "mixed.example resolves to private address 10.1.2.3");
});
