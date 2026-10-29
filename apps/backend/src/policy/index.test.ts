import assert from "node:assert/strict";
import { test } from "node:test";
import { REGISTRY_HOSTS, addressCategory, checkRequest, isPublicIp, publicOnlyLookup, resolveAndCheck } from "./index.ts";

const get = (url: string, resolvedIps?: string[]) => ({ method: "GET", url, resolvedIps });

test("off denies everything", () => {
  for (const url of ["https://pypi.org/simple/", "https://example.com/", "http://127.0.0.1/"]) {
    assert.deepEqual(checkRequest("off", get(url)), { allow: false, reason: "mode off", host: new URL(url).hostname });
  }
});

test("registries: exact hosts, GET/HEAD only, standard ports", () => {
  for (const host of REGISTRY_HOSTS) assert.equal(checkRequest("registries", get(`https://${host}/x`)).allow, true, host);
  assert.equal(checkRequest("registries", { method: "HEAD", url: "https://pypi.org/simple/" }).allow, true);
  assert.equal(checkRequest("registries", get("https://PyPI.org./simple/")).allow, true);
  assert.equal(checkRequest("registries", get("https://example.com/")).reason, "host not in registries list");
  assert.equal(checkRequest("registries", get("https://evil.pypi.org/")).reason, "host not in registries list");
  assert.equal(checkRequest("registries", get("https://pypi.org.evil.com/")).reason, "host not in registries list");
  assert.equal(checkRequest("registries", { method: "POST", url: "https://pypi.org/legacy/" }).reason, "method POST not allowed in registries mode");
  assert.equal(checkRequest("registries", { method: "PUT", url: "https://registry.npmjs.org/x" }).allow, false);
  assert.equal(checkRequest("registries", get("https://pypi.org:8443/")).reason, "port 8443 not allowed in registries mode");
});

test("registries: git fetch over smart HTTP is allowed, push is not", () => {
  assert.equal(checkRequest("registries", { method: "POST", url: "https://github.com/a/b.git/git-upload-pack" }).allow, true);
  assert.equal(checkRequest("registries", { method: "POST", url: "https://github.com/a/b/git-upload-pack" }).allow, true);
  assert.equal(checkRequest("registries", { method: "POST", url: "https://github.com/a/b.git/git-receive-pack" }).allow, false);
  assert.equal(checkRequest("registries", { method: "POST", url: "https://github.com/a/b/c/git-upload-pack" }).allow, false);
  assert.equal(checkRequest("registries", { method: "POST", url: "https://codeload.github.com/a/b/git-upload-pack" }).allow, false);
});

test("web: public http(s), any method", () => {
  assert.deepEqual(checkRequest("web", get("https://example.com/")), { allow: true, reason: "allowed: web", host: "example.com" });
  assert.equal(checkRequest("web", { method: "POST", url: "http://example.com:8080/x" }).allow, true);
  assert.equal(checkRequest("web", get("https://example.com/", ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"])).allow, true);
});

test("schemes and credentials", () => {
  assert.equal(checkRequest("web", get("ftp://example.com/")).reason, "scheme ftp not allowed");
  assert.equal(checkRequest("web", get("ws://example.com/")).reason, "scheme ws not allowed");
  assert.equal(checkRequest("web", get("https://user:pw@example.com/")).reason, "credentials in URL");
  assert.equal(checkRequest("web", get("not a url")).reason, "invalid URL");
});

test("internal literals denied in every mode with a named reason", () => {
  const cases: [string, string][] = [
    ["http://127.0.0.1:8010/", "loopback address 127.0.0.1"],
    ["http://127.1/", "loopback address 127.0.0.1"],
    ["http://2130706433/", "loopback address 127.0.0.1"],
    ["http://0x7f000001/", "loopback address 127.0.0.1"],
    ["http://0.0.0.0/", "unspecified address 0.0.0.0"],
    ["http://10.1.2.3/", "private address 10.1.2.3"],
    ["http://172.20.0.1/", "private address 172.20.0.1"],
    ["http://192.168.1.4/", "private address 192.168.1.4"],
    ["http://100.100.1.1/", "CGNAT address 100.100.1.1"],
    ["http://169.254.169.254/latest/meta-data/", "metadata address 169.254.169.254"],
    ["http://168.63.129.16/", "metadata address 168.63.129.16"],
    ["http://169.254.1.1/", "link-local address 169.254.1.1"],
    ["http://224.0.0.251/", "multicast address 224.0.0.251"],
    ["http://255.255.255.255/", "reserved address 255.255.255.255"],
    ["http://[::1]/", "loopback address ::1"],
    ["http://[::]/", "unspecified address ::"],
    ["http://[::ffff:127.0.0.1]/", "loopback address ::ffff:7f00:1"],
    ["http://[::ffff:192.168.1.4]/", "private address ::ffff:c0a8:104"],
    ["http://[fd12:3456::1]/", "ULA address fd12:3456::1"],
    ["http://[fe80::1]/", "link-local address fe80::1"],
    ["http://[fd00:ec2::254]/", "metadata address fd00:ec2::254"],
    ["http://[ff02::1]/", "multicast address ff02::1"],
    ["http://[2002:7f00:1::]/", "6to4 address 2002:7f00:1::"],
    ["http://[64:ff9b::7f00:1]/", "NAT64 address 64:ff9b::7f00:1"],
    ["http://[2001:db8::1]/", "documentation address 2001:db8::1"],
  ];
  for (const mode of ["web", "registries"] as const) {
    for (const [url, reason] of cases) assert.equal(checkRequest(mode, get(url)).reason, reason, `${mode} ${url}`);
  }
});

test("internal hostnames denied before DNS", () => {
  for (const host of ["localhost", "foo.localhost", "host.docker.internal", "gateway.docker.internal", "mac.local", "router.lan", "nas.home.arpa", "intranet", "localhost."]) {
    const d = checkRequest("web", get(`http://${host}/`));
    assert.equal(d.allow, false, host);
    assert.match(d.reason, /^(internal|single-label) hostname /, host);
  }
});

test("resolved addresses: any non-public answer denies (rebinding, nip.io)", () => {
  assert.equal(checkRequest("web", get("http://127.0.0.1.nip.io/", ["127.0.0.1"])).reason, "127.0.0.1.nip.io resolves to loopback address 127.0.0.1");
  assert.equal(checkRequest("web", get("http://rebind.example/", ["93.184.215.14", "192.168.1.1"])).reason, "rebind.example resolves to private address 192.168.1.1");
  assert.equal(checkRequest("registries", get("https://pypi.org/", ["10.0.0.5"])).allow, false);
  assert.equal(checkRequest("web", get("http://x.example/", [])).reason, "x.example did not resolve");
});

test("isPublicIp / addressCategory", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.215.14", "2606:4700::1111", "2a04:4e42:200::223"]) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.64.1", "100.64.0.1", "169.254.169.254", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1%en0", "::", "garbage"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(addressCategory("::ffff:8.8.8.8"), "IPv4-mapped");
  assert.equal(addressCategory("2001::1"), "IETF protocol"); // Teredo
});

test("resolveAndCheck uses the lookup and returns the IPs", async () => {
  const lookup = async (h: string) => (h === "good.example" ? ["93.184.215.14"] : h === "evil.example" ? ["127.0.0.1"] : Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })));
  assert.deepEqual(await resolveAndCheck("web", { method: "GET", url: "https://good.example/" }, lookup), { allow: true, reason: "allowed: web", host: "good.example", ips: ["93.184.215.14"] });
  assert.equal((await resolveAndCheck("web", { method: "GET", url: "https://evil.example/" }, lookup)).reason, "evil.example resolves to loopback address 127.0.0.1");
  assert.equal((await resolveAndCheck("web", { method: "GET", url: "https://nx.example/" }, lookup)).reason, "DNS lookup failed (ENOTFOUND)");
  assert.equal((await resolveAndCheck("off", { method: "GET", url: "https://good.example/" }, lookup)).reason, "mode off");
});

test("publicOnlyLookup refuses internal answers", async () => {
  const lk = publicOnlyLookup(async (h) => (h === "evil.example" ? ["93.184.215.14", "10.0.0.1"] : ["93.184.215.14"]));
  const run = (h: string, all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((resolve) => lk(h, { all }, (err, addr) => resolve({ err, addr })));
  assert.equal((await run("good.example", false)).addr, "93.184.215.14");
  assert.deepEqual((await run("good.example", true)).addr, [{ address: "93.184.215.14", family: 4 }]);
  assert.equal((await run("evil.example", true)).err?.code, "EPOLICY");
});
