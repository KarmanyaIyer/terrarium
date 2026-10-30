// Review 6 cases (qa/review6-cases), shared by the node and VM grading tests and qa/review6-cases/run.py.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "../config.ts";
import type { Iso } from "./review5.ts";

export const REVIEW6_DIR = join(REPO_DIR, "qa/review6-cases");

/** Item -> case -> [plain unittest passes, protected grading verdict]. */
export const REVIEW6: Record<string, Record<string, [boolean, Iso]>> = JSON.parse(readFileSync(join(REVIEW6_DIR, "expect.json"), "utf8"));

/** Correct code that must also grade in seconds (review 6, #4: per-message cost). */
export const REVIEW6_PERF = new Set(["function_many", "function_many_2000"]);
