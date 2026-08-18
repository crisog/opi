import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseChildResponse } from "./index.ts";
import { createJobStore, type JobStore } from "./job-store.ts";

const JOB_STDOUT_FILE = "stdout.ndjson";
const JOB_STDERR_FILE = "stderr.log";
const JOB_RESULT_FILE = "result.md";
const MAX_ERROR_LENGTH = 2_000;
const CANCELLATION_POLL_INTERVAL_MS = 25;

type RunJobWorkerParams = {
  store: JobStore;
  jobId: string;
};

type ChildExit = {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ChildLaunchError = {
  kind: "error";
  error: Error;
};

type ChildOutcome = ChildExit | ChildLaunchError;

type WaitForChildParams = {
  child: ChildProcess;
  store: JobStore;
  jobId: string;
};

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH) || "Unknown subagent worker error.";
}

function waitForChild({ child, store, jobId }: WaitForChildParams): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let isSettled = false;
    let isTerminationRequested = false;

    const settle = (outcome: ChildOutcome): void => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    const pollCancellation = async (): Promise<void> => {
      if (isSettled) return;
      try {
        if (!isTerminationRequested && (await store.isCancellationRequested({ jobId }))) {
          isTerminationRequested = true;
          child.kill();
        }
      } catch (error) {
        settle({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
        return;
      }
      if (!isSettled) timer = setTimeout(pollCancellation, CANCELLATION_POLL_INTERVAL_MS);
    };

    child.once("error", (error) => settle({ kind: "error", error }));
    child.once("close", (code, signal) => settle({ kind: "exit", code, signal }));
    timer = setTimeout(pollCancellation, CANCELLATION_POLL_INTERVAL_MS);
  });
}

export async function runJobWorker({ store, jobId }: RunJobWorkerParams): Promise<void> {
  try {
    const job = await store.markRunning({ jobId });
    if (job.kind === "cancel_requested") {
      await store.markCancelled({ jobId });
      return;
    }
    if (job.kind !== "running") return;

    const stdoutPath = join(job.directoryPath, JOB_STDOUT_FILE);
    const stderrPath = join(job.directoryPath, JOB_STDERR_FILE);
    const stdoutFile = await open(stdoutPath, "wx", 0o600);
    const stderrFile = await open(stderrPath, "wx", 0o600);
    let outcome: ChildOutcome;

    try {
      const child = spawn(job.childCommand, [...job.childArgs, `@${job.taskPath}`], {
        cwd: job.workspacePath,
        stdio: ["ignore", stdoutFile.fd, stderrFile.fd]
      });
      outcome = await waitForChild({ child, store, jobId });
    } finally {
      await Promise.all([stdoutFile.close(), stderrFile.close()]);
    }

    if (outcome.kind === "error") throw new Error(`Subagent child failed to launch: ${outcome.error.message}`);
    if (await store.isCancellationRequested({ jobId })) {
      await store.markCancelled({ jobId });
      return;
    }

    const [stdout, stderr] = await Promise.all([readFile(stdoutPath, "utf8"), readFile(stderrPath, "utf8")]);
    const response = parseChildResponse(stdout);
    if (outcome.code !== 0) {
      const reason = response.errorMessage || stderr.trim() || `Pi exited with code ${String(outcome.code)}.`;
      throw new Error(`Subagent child failed: ${reason}`);
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`Subagent child ${response.stopReason}: ${response.errorMessage ?? "No details returned."}`);
    }
    if (!response.text) throw new Error("Subagent child returned no final response.");

    const resultPath = join(job.directoryPath, JOB_RESULT_FILE);
    await writeFile(resultPath, response.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await store.markCompleted({ jobId, resultPath });
  } catch (error) {
    if (await store.isCancellationRequested({ jobId })) {
      await store.markCancelled({ jobId });
      return;
    }
    await store.markFailed({ jobId, error: formatError(error) });
  }
}

async function runFromCommandLine(): Promise<void> {
  const [agentDirectory, workspacePath, jobId] = process.argv.slice(2);
  if (!agentDirectory || !workspacePath || !jobId) {
    throw new Error("Subagent worker requires agent directory, workspace path, and job ID.");
  }
  const store = await createJobStore({ agentDirectory, workspacePath });
  await runJobWorker({ store, jobId });
}

const currentScript = process.argv[1];
if (currentScript && import.meta.url === pathToFileURL(currentScript).href) {
  runFromCommandLine().catch((error: unknown) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
