import { spawn } from "node:child_process";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createSchedulerStore, type SchedulerStore } from "./scheduler-store.ts";

const MAX_ERROR_LENGTH = 2_000;

type RunScheduledTaskParams = {
  store: SchedulerStore;
  id: string;
};

type JsonObject = Record<string, unknown>;

type ChildResponse = {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
};

type ChildOutcome =
  | {
      kind: "exit";
      code: number | null;
    }
  | {
      kind: "error";
      error: Error;
    };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (!isJsonObject(part) || part["type"] !== "text" || typeof part["text"] !== "string") continue;
    parts.push(part["text"]);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseChildResponse(stdout: string): ChildResponse {
  let response: ChildResponse = {};
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonObject(event) || event["type"] !== "message_end") continue;
    const message = event["message"];
    if (!isJsonObject(message) || message["role"] !== "assistant") continue;
    response = {
      text: textFromContent(message["content"]),
      stopReason: typeof message["stopReason"] === "string" ? message["stopReason"] : undefined,
      errorMessage: typeof message["errorMessage"] === "string" ? message["errorMessage"] : undefined
    };
  }
  return response;
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH) || "Unknown scheduled task error.";
}

export async function runScheduledTask({ store, id }: RunScheduledTaskParams): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const task = await store.readTask({ id });
    await store.markRunRunning({ id, startedAt });
    const stdoutFile = await open(task.stdoutPath, "w", 0o600);
    const stderrFile = await open(task.stderrPath, "w", 0o600);
    let outcome: ChildOutcome;
    try {
      const child = spawn(task.childCommand, task.childArgs, {
        cwd: task.workspacePath,
        env: { ...process.env, ...task.environment },
        stdio: ["ignore", stdoutFile.fd, stderrFile.fd]
      });
      outcome = await new Promise<ChildOutcome>((resolve) => {
        child.once("error", (error) => resolve({ kind: "error", error }));
        child.once("close", (code) => resolve({ kind: "exit", code }));
      });
    } finally {
      await Promise.all([stdoutFile.close(), stderrFile.close()]);
    }

    if (outcome.kind === "error") throw new Error(`Scheduled child failed to launch: ${outcome.error.message}`);
    const [stdout, stderr] = await Promise.all([readFile(task.stdoutPath, "utf8"), readFile(task.stderrPath, "utf8")]);
    const response = parseChildResponse(stdout);
    if (outcome.code !== 0) {
      throw new Error(response.errorMessage || stderr.trim() || `Pi exited with code ${String(outcome.code)}.`);
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `Pi stopped with ${response.stopReason}.`);
    }
    if (!response.text) throw new Error("Scheduled child returned no final response.");

    const temporaryResultPath = `${task.resultPath}.tmp`;
    await writeFile(temporaryResultPath, response.text, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryResultPath, task.resultPath);
    await store.markRunCompleted({ id, startedAt, resultPath: task.resultPath });
  } catch (error) {
    await store.markRunFailed({ id, startedAt, error: formatError(error) });
  }
}

async function runFromCommandLine(): Promise<void> {
  const [agentDirectory, workspacePath, id] = process.argv.slice(2);
  if (!agentDirectory || !workspacePath || !id) {
    throw new Error("Scheduler runner requires agent directory, workspace path, and task ID.");
  }
  const store = await createSchedulerStore({ agentDirectory, workspacePath });
  await runScheduledTask({ store, id });
}

const currentScript = process.argv[1];
if (currentScript && import.meta.url === pathToFileURL(currentScript).href) {
  runFromCommandLine().catch((error: unknown) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
