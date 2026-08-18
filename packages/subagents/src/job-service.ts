import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJobStore, type JobStore, type QueuedJob, type StoredJob } from "./job-store.ts";

const WORKER_PATH = fileURLToPath(new URL("job-worker.ts", import.meta.url));
const WAIT_POLL_INTERVAL_MS = 100;

type StartSubagentJobParams = {
  agentDirectory: string;
  workspacePath: string;
  task: string;
  childCommand: string;
  childArgs: string[];
  model?: string;
  thinkingLevel?: string;
};

type WaitForSubagentJobParams = {
  store: JobStore;
  jobId: string;
  signal?: AbortSignal;
};

type WaitForDelayParams = {
  durationMs: number;
  signal?: AbortSignal;
};

type LaunchWorkerParams = {
  store: JobStore;
  job: QueuedJob;
  agentDirectory: string;
};

function isTerminalJob(job: StoredJob): boolean {
  return job.kind === "completed" || job.kind === "failed" || job.kind === "cancelled";
}

function waitForDelay({ durationMs, signal }: WaitForDelayParams): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, durationMs);
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Subagent job wait was cancelled."));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function launchWorker({ store, job, agentDirectory }: LaunchWorkerParams): Promise<void> {
  const worker = spawn(
    process.execPath,
    ["--experimental-strip-types", WORKER_PATH, agentDirectory, job.workspacePath, job.id],
    { detached: true, stdio: "ignore" }
  );

  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("spawn", resolve);
      worker.once("error", reject);
    });
    worker.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.markFailed({ jobId: job.id, error: `Subagent worker failed to launch: ${message}` });
    throw error;
  }
}

export async function startSubagentJob({
  agentDirectory,
  workspacePath,
  task,
  childCommand,
  childArgs,
  model,
  thinkingLevel
}: StartSubagentJobParams): Promise<QueuedJob> {
  const store = await createJobStore({ agentDirectory, workspacePath });
  const job = await store.createQueuedJob({
    task,
    childCommand,
    childArgs,
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel })
  });
  await launchWorker({ store, job, agentDirectory });
  return job;
}

export async function waitForSubagentJob({ store, jobId, signal }: WaitForSubagentJobParams): Promise<StoredJob> {
  while (true) {
    signal?.throwIfAborted();
    const job = await store.readJob({ jobId });
    if (isTerminalJob(job)) return job;
    await waitForDelay({ durationMs: WAIT_POLL_INTERVAL_MS, signal });
  }
}
