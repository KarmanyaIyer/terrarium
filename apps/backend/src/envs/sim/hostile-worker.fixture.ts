// Deliberately hostile protocol peer used by supervisor tests. It runs inside the same Seatbelt profile as the
// real worker so malformed traffic and a CPU wedge exercise the production guard and host parser.

const mode = process.argv[2] ?? "malformed-reply";
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

send({ type: "ready" });
if (mode === "invalid-json") process.stdout.write("{not json\n");
if (mode === "unsolicited") send({ type: "reply", id: 999, ok: true, result: {} });
if (mode === "fetch-flood") {
  for (let reqId = 1; reqId <= 9; reqId++) {
    send({ type: "fetch", reqId, url: `https://example.com/${reqId}`, method: "GET", headers: {}, followRedirects: false });
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text: string) => {
  input += text;
  let nl: number;
  while ((nl = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, nl);
    input = input.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line) as { id: number; op: string };
    if (mode === "malformed-reply" && req.op === "init") {
      send({ type: "reply", id: req.id, ok: true, result: "not an object" });
      continue;
    }
    if (mode === "wedge" && req.op === "exec") {
      for (;;) {}
    }
    if (mode === "giant-dump" && req.op === "dump") {
      send({ type: "chunk", id: req.id, entries: [{ p: "/workspace/giant", t: "f", m: 420, mt: Date.now(), d: "A".repeat(12 * 1024 * 1024) }] });
      send({ type: "reply", id: req.id, ok: true, result: { count: 1, bytes: 9 * 1024 * 1024 } });
      continue;
    }
    if (req.op === "facts") send({ type: "reply", id: req.id, ok: true, result: { commands: [], totalBytes: 0, node: process.version } });
    else send({ type: "reply", id: req.id, ok: true, result: {} });
  }
});
