import type { EnvSummary } from "@terrarium/shared";

/** Starter tasks per place the session runs: each shows something different on record (files, commands, the network log). */
export function starters(env: Pick<EnvSummary, "type" | "network"> | undefined, chat: boolean, strain: boolean): string[] {
  if (strain) return ["What should I make for dinner tonight?", "Describe your home in three sentences.", "Tell me a short story about a lost key."];
  if (!env || chat)
    return [
      "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?",
      "Explain the difference between a process and a thread in three sentences.",
      "Write a haiku about a terrarium.",
    ];
  const net =
    env.network === "off"
      ? "Fetch https://example.com with curl and tell me what happened."
      : env.type === "vm"
        ? "Install the requests package with pip, then print its version."
        : "Fetch https://example.com with curl and show the page title.";
  if (env.type === "vm")
    return [
      "Write a Python script that prints the first 20 prime numbers, save it as primes.py and run it.",
      "Show the kernel version, the CPU count and the free memory of this machine.",
      net,
      "Try to read a file from the Mac outside this environment and tell me what happened.",
    ];
  return [
    "Create three files a.txt, b.txt and c.txt with one line each, then show them with cat.",
    "Make a CSV of five fruits and their prices, then print the most expensive one with awk.",
    net,
    "Try to read a file from the Mac outside this environment and tell me what happened.",
  ];
}
