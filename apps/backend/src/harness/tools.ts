// Agent tools routed into an EnvRuntime. `terrarium` set: bash/read/write/edit (research/harness.md §6).
// `pi-stock` set: Pi 1.4.0's tool shapes (edit takes edits[]) over the same runtime.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { EnvRuntime, ExecOutcome } from "../envs/types.ts";
import { normalizePath } from "../envs/sim/runtime.ts";

export interface ToolDetails {
  kind: "bash" | "read" | "write" | "edit";
  path?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  truncated?: boolean;
  [k: string]: unknown;
}

export interface ToolHost {
  runtime: EnvRuntime;
  /** Streamed stdout/stderr for the UI (never sent to the model). */
  onOutput(toolCallId: string, stream: "stdout" | "stderr", chunk: string): void;
  /** Max characters of tool output given to the model. */
  outputChars: number;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;

function text(t: string, details: ToolDetails, isError = false): AgentToolResult<ToolDetails> {
  return { content: [{ type: "text", text: t }], details, ...(isError ? { isError: true } : {}) };
}

/** Clip to `max` chars keeping the head (40%) and tail (60%) on line boundaries. */
export function clipForModel(s: string, max: number): string {
  if (s.length <= max) return s;
  const headLen = Math.floor(max * 0.4);
  const tailLen = max - headLen;
  const head = s.slice(0, headLen);
  const tail = s.slice(s.length - tailLen);
  const h = head.slice(0, Math.max(head.lastIndexOf("\n"), 0) || headLen);
  const t = tail.slice(tail.indexOf("\n") + 1 || 0);
  const removed = s.length - h.length - t.length;
  return `${h}\n[... ${removed} characters of output removed by the harness ...]\n${t}`;
}

export function formatExec(r: ExecOutcome, maxChars: number): string {
  const out = r.stdout.replace(/\n$/, "");
  const err = r.stderr.replace(/\n$/, "");
  if (r.exitCode === 0 && !err) return clipForModel(out || "(no output)", maxChars);
  const parts = [`exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`];
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  if (!out && !err) parts.push("(no output)");
  return clipForModel(parts.join("\n"), maxChars);
}

function decodeText(data: Uint8Array): string | null {
  const head = data.subarray(0, 8192);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

async function runBash(host: ToolHost, toolCallId: string, command: string, signal: AbortSignal | undefined, timeoutMs?: number) {
  const r = await host.runtime.exec(command, {
    as: "agent",
    cwd: "/workspace",
    timeoutMs: timeoutMs ?? 120_000,
    signal,
    onStdout: (c) => host.onOutput(toolCallId, "stdout", c),
    onStderr: (c) => host.onOutput(toolCallId, "stderr", c),
  });
  return text(formatExec(r, host.outputChars), { kind: "bash", exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs, truncated: r.truncated });
}

async function readText(host: ToolHost, path: string): Promise<{ abs: string; content: string }> {
  const abs = normalizePath(path);
  const r = await host.runtime.readFile(abs, { maxBytes: MAX_READ_BYTES, as: "agent" });
  if (r.truncated) throw new Error(`${abs} is ${r.size} bytes; larger than the ${MAX_READ_BYTES}-byte limit. Use bash (head, sed -n) to read parts of it.`);
  const content = decodeText(r.data);
  if (content === null) throw new Error(`${abs} is a binary file`);
  return { abs, content };
}

async function readTool(host: ToolHost, path: string, offset?: number, limit?: number) {
  const { abs, content } = await readText(host, path);
  const lines = content.split("\n");
  const start = Math.max(1, Math.floor(offset ?? 1));
  const count = Math.max(1, Math.floor(limit ?? 400));
  const slice = lines.slice(start - 1, start - 1 + count);
  let out = slice.join("\n");
  const end = start - 1 + slice.length;
  if (start > 1 || end < lines.length) out += `\n[lines ${start}-${end} of ${lines.length}; use offset to read more]`;
  if (!content) out = "(empty file)";
  return text(clipForModel(out, host.outputChars), { kind: "read", path: abs, bytes: content.length });
}

async function writeTool(host: ToolHost, path: string, content: string) {
  const abs = normalizePath(path);
  await host.runtime.writeFile(abs, content, { as: "agent" });
  return text(`wrote ${Buffer.byteLength(content)} bytes to ${abs}`, { kind: "write", path: abs });
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

async function editTool(host: ToolHost, path: string, edits: { oldText: string; newText: string }[]) {
  const { abs, content } = await readText(host, path);
  // Every oldText is matched against the original file (Pi semantics); apply from the end so offsets hold.
  const spans: { at: number; oldText: string; newText: string }[] = [];
  for (const e of edits) {
    const n = countOccurrences(content, e.oldText);
    if (n === 0) throw new Error(`old text not found in ${abs}${e.oldText ? "" : " (old text is empty)"}`);
    if (n > 1) throw new Error(`old text matches ${n} places in ${abs}; include more surrounding lines so it is unique`);
    spans.push({ at: content.indexOf(e.oldText), oldText: e.oldText, newText: e.newText });
  }
  spans.sort((a, b) => b.at - a.at);
  for (let i = 1; i < spans.length; i++) if (spans[i].at + spans[i].oldText.length > spans[i - 1].at) throw new Error("edits overlap; merge them into one edit");
  let next = content;
  for (const s of spans) next = next.slice(0, s.at) + s.newText + next.slice(s.at + s.oldText.length);
  await host.runtime.writeFile(abs, next, { as: "agent" });
  return text(`edited ${abs} (${spans.length} replacement${spans.length === 1 ? "" : "s"})`, { kind: "edit", path: abs, replacements: spans.length });
}

/** Infers execute() params from the schema, then erases to the list type. */
function defineTool<T extends TSchema>(t: AgentTool<T, ToolDetails>): AgentTool<any, ToolDetails> {
  return t as unknown as AgentTool<any, ToolDetails>;
}

export function terrariumTools(host: ToolHost): AgentTool<any, ToolDetails>[] {
  return [
    defineTool({
      name: "bash",
      label: "bash",
      description: "Run a shell command in /workspace. Returns exit code, stdout and stderr.",
      parameters: Type.Object({ command: Type.String({ description: "The command to run" }) }),
      executionMode: "sequential",
      execute: (id, p, signal) => runBash(host, id, p.command, signal),
    }),
    defineTool({
      name: "read",
      label: "read",
      description: "Read a text file. Use offset and limit for long files.",
      parameters: Type.Object({
        path: Type.String({ description: "File path, relative to /workspace or absolute" }),
        offset: Type.Optional(Type.Number({ description: "First line to read (1-based)" })),
        limit: Type.Optional(Type.Number({ description: "Number of lines to read" })),
      }),
      executionMode: "sequential",
      execute: (_id, p) => readTool(host, p.path, p.offset, p.limit),
    }),
    defineTool({
      name: "write",
      label: "write",
      description: "Create or overwrite a file.",
      parameters: Type.Object({ path: Type.String({ description: "File path" }), content: Type.String({ description: "Full file content" }) }),
      executionMode: "sequential",
      execute: (_id, p) => writeTool(host, p.path, p.content),
    }),
    defineTool({
      name: "edit",
      label: "edit",
      description: "Replace one exact piece of text in a file.",
      parameters: Type.Object({
        path: Type.String({ description: "File path" }),
        old_text: Type.String({ description: "Exact text to replace; must occur once" }),
        new_text: Type.String({ description: "Replacement text" }),
      }),
      executionMode: "sequential",
      execute: (_id, p) => editTool(host, p.path, [{ oldText: p.old_text, newText: p.new_text }]),
    }),
  ];
}

/** Pi coding-agent 1.4.0 tool shapes, executed in our envs. */
export function piStockTools(host: ToolHost): AgentTool<any, ToolDetails>[] {
  return [
    defineTool({
      name: "read",
      label: "read",
      description: "Read the contents of a file. Use offset/limit for large files.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
        offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      }),
      executionMode: "sequential",
      execute: (_id, p) => readTool(host, p.path, p.offset, p.limit),
    }),
    defineTool({
      name: "bash",
      label: "bash",
      description: "Execute a bash command in the current working directory. Returns stdout and stderr.",
      parameters: Type.Object({
        command: Type.String({ description: "Bash command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
      }),
      executionMode: "sequential",
      execute: (id, p, signal) => runBash(host, id, p.command, signal, p.timeout ? Math.min(p.timeout * 1000, 600_000) : undefined),
    }),
    defineTool({
      name: "edit",
      label: "edit",
      description: "Edit a file by replacing exact text. Each edits[].oldText must match exactly and be unique in the original file.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { description: "Replacements, matched against the original file" }),
      }),
      executionMode: "sequential",
      execute: (_id, p) => editTool(host, p.path, p.edits),
    }),
    defineTool({
      name: "write",
      label: "write",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
      parameters: Type.Object({ path: Type.String({ description: "Path to the file to write (relative or absolute)" }), content: Type.String({ description: "Content to write to the file" }) }),
      executionMode: "sequential",
      execute: (_id, p) => writeTool(host, p.path, p.content),
    }),
  ];
}
