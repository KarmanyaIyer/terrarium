// Fixture data for settings, harness profiles and model downloads (prompt texts mirror apps/backend/src/harness/prompts.ts).

import type { AppSettings, HarnessInfo, ModelCheck, ModelSuggestion, SettingsInfo, ToolDefinition } from "@terrarium/shared";

export const DEFAULT_SETTINGS: AppSettings = {
  memoryBudgetBytes: 12e9,
  resourceBudgets: {
    maxSimWorkers: 8,
    simWorkerRssBytes: 1024 * 1024 * 1024,
    simWorkerCpuMs: 30 * 60_000,
    hostFreeDiskReserveBytes: 20 * 1024 * 1024 * 1024,
    sessionTraceBytes: 1024 * 1024 * 1024,
    sessionCaptureBytes: 512 * 1024 * 1024,
    sessionSnapshotCount: 256,
    sessionNetworkRows: 2000,
    sessionRequestCount: 200,
    sessionNetworkBytes: 256 * 1024 * 1024,
    networkBurst: 120,
    networkRefillPerSecond: 20,
  },
  newSession: { modelId: null, contextWindow: null, thinking: "model", harness: "terrarium" },
  newEnv: { type: "vm", network: "off" },
  prompts: {},
};

export const TERRARIUM_PROMPT = `You are an agent working in a sandboxed Linux environment. Your working directory is /workspace.

Use tools to inspect files and run commands. Do not guess file contents.
- bash: run a shell command. Each call starts a fresh shell in /workspace.
- read: read a text file. Use offset and limit for long files.
- write: create or overwrite a file.
- edit: replace one exact piece of text in a file.

Call one tool at a time and check its output before the next step. Keep replies short. When the task is done, reply with a short summary and no tool call.`;

export const SIM_NOTE = `\n\nThis environment is a simulated shell (just-bash): common Unix commands work, but it is not a real OS. There is no package manager, no pip, and no compiler.`;

const PI_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
</tools>

<cwd>
/workspace
</cwd>`;

const CHAT_PROMPT = `You are a helpful assistant. Answer directly and concisely.`;

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

const TERRARIUM_TOOLS: ToolDefinition[] = [
  { name: "bash", description: "Run a shell command in /workspace. Returns exit code, stdout and stderr.", parameters: obj({ command: str("The command to run") }, ["command"]) },
  { name: "read", description: "Read a text file. Use offset and limit for long files.", parameters: obj({ path: str("File path, relative to /workspace or absolute") }, ["path"]) },
  { name: "write", description: "Create or overwrite a file.", parameters: obj({ path: str("File path"), content: str("Full file content") }, ["path", "content"]) },
  { name: "edit", description: "Replace one exact piece of text in a file.", parameters: obj({ path: str("File path"), old_text: str("Exact text to replace; must occur once"), new_text: str("Replacement text") }, ["path", "old_text", "new_text"]) },
];

const PI_TOOLS: ToolDefinition[] = [
  { name: "read", description: "Read the contents of a file. Use offset/limit for large files.", parameters: obj({ path: str("Path to the file to read (relative or absolute)") }, ["path"]) },
  { name: "bash", description: "Execute a bash command in the current working directory. Returns stdout and stderr.", parameters: obj({ command: str("Bash command to execute") }, ["command"]) },
  { name: "edit", description: "Edit a file by replacing exact text. Each edits[].oldText must match exactly and be unique in the original file.", parameters: obj({ path: str("Path to the file to edit") }, ["path"]) },
  { name: "write", description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.", parameters: obj({ path: str("Path to the file to write"), content: str("Content to write to the file") }, ["path", "content"]) },
];

const rough = (s: string) => Math.ceil(s.length / 4);

export function harnessFixture(prompts: AppSettings["prompts"]): HarnessInfo[] {
  const mk = (id: HarnessInfo["id"], builtIn: string, tools: ToolDefinition[]): HarnessInfo => {
    const prompt = prompts[id] ?? builtIn;
    return {
      id,
      prompt,
      builtIn,
      ...(id === "terrarium" ? { simNote: SIM_NOTE } : {}),
      custom: prompts[id] != null,
      tools,
      tokensEst: { prompt: rough(prompt), tools: tools.length ? rough(JSON.stringify(tools)) : 0 },
    };
  };
  return [mk("terrarium", TERRARIUM_PROMPT, TERRARIUM_TOOLS), mk("pi-stock", PI_PROMPT, PI_TOOLS), mk("chat", CHAT_PROMPT, [])];
}

export function settingsInfo(settings: AppSettings, ceiling: number | undefined, status: SettingsInfo["omlx"]): SettingsInfo {
  const G = 1e9;
  return {
    settings,
    paths: {
      data: "/Users/you/Projects/terrarium/data",
      models: "/Users/you/Projects/terrarium/models",
      venv: "/Users/you/Projects/terrarium/.venv",
      logs: "/Users/you/Library/Logs/Terrarium/backend.log",
      omlxLog: "/Users/you/Projects/terrarium/data/omlx/server.log",
    },
    disk: [
      { key: "envs", label: "Environment disks", bytes: 1.9 * G },
      { key: "snapshots", label: "Snapshots", bytes: 0.6 * G },
      { key: "blobs", label: "Trace blobs", bytes: 0.21 * G },
      { key: "images", label: "VM images", bytes: 1.28 * G },
      { key: "omlx", label: "oMLX cache and logs", bytes: 4.2 * G },
      { key: "datasets", label: "Eval datasets", bytes: 0.008 * G },
      { key: "gondolin", label: "VM package cache", bytes: 0.24 * G },
      { key: "db", label: "Database", bytes: 0.004 * G },
      { key: "models", label: "Models", bytes: 29.2 * G },
    ],
    freeDiskBytes: 412 * G,
    maxRunningVms: 2,
    omlx: { ...status, appliedCeilingBytes: ceiling },
  };
}

export const SUGGESTIONS: ModelSuggestion[] = [
  {
    repo: "LiquidAI/LFM3-1.7B-MLX-4bit",
    name: "LFM3 1.7B",
    params: "1.7B",
    note: "Vendor-reported BFCL v4 71.4 (Qwen3.5 4B: 55.1), IFEval 96.7, GPQA Diamond 63.4 (Qwen3.5 4B: 75.8); 256K context",
    sizeBytes: 991_073_260,
    released: "2026-10-27",
  },
  { repo: "mlx-community/Qwen3.5-2B-4bit", name: "Qwen3.5 2B", params: "2B", note: "Smallest Qwen3.5; same tool format as the 4B and 9B", sizeBytes: 1_749_080_357 },
  { repo: "mlx-community/gemma-4-e2b-it-4bit", name: "Gemma 4 E2B", params: "E2B", note: "Gemma 4 on-device size; 128K context", sizeBytes: 3_583_087_091 },
  { repo: "mlx-community/gemma-4-e4b-it-4bit", name: "Gemma 4 E4B", params: "E4B", note: "Gemma 4 on-device size, larger; 128K context", sizeBytes: 5_179_239_942 },
];

export function inspectFixture(repo: string, installed: boolean): ModelCheck {
  const versions = { mlxLm: "0.31.4.dev132+g94cdcae13", mlxVlm: "0.7.8" };
  const s = SUGGESTIONS.find((x) => x.repo === repo);
  const lfm = repo.startsWith("LiquidAI/LFM3");
  const problems = lfm ? [`mlx-lm ${versions.mlxLm} has no lfm3 architecture (mlx_lm/models/lfm3.py missing), so oMLX can't load it; it needs a newer mlx-lm`] : [];
  return {
    repo,
    dirName: repo.split("/")[1]!,
    installed,
    totalBytes: s?.sizeBytes ?? 2.1e9,
    files: 10,
    modelType: lfm ? "lfm3" : repo.includes("gemma") ? "gemma4" : "qwen3_5",
    loader: lfm ? "mlx-lm" : "mlx-vlm",
    mlx: true,
    quant: "4bit",
    contextLength: lfm ? 262144 : 131072,
    ok: !problems.length && !installed,
    problems,
    freeDiskBytes: 412e9,
    versions,
  };
}
