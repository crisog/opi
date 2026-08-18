import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const JOB_STORE_DIRECTORY = "subagent-jobs";
const JOB_RECORD_FILE = "job.json";
const JOB_TASK_FILE = "task.md";
const JOB_CANCELLATION_FILE = "cancel-requested";
const JOB_ID_PATTERN = /^[0-9a-f-]+$/u;
const MAX_TASK_SUMMARY_LENGTH = 160;

const JOB_BASE_PROPERTIES = {
  version: Type.Literal(1),
  id: Type.String({ minLength: 1 }),
  workspacePath: Type.String({ minLength: 1 }),
  directoryPath: Type.String({ minLength: 1 }),
  taskPath: Type.String({ minLength: 1 }),
  taskSummary: Type.String({ minLength: 1, maxLength: MAX_TASK_SUMMARY_LENGTH }),
  childCommand: Type.String({ minLength: 1 }),
  childArgs: Type.Array(Type.String()),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinkingLevel: Type.Optional(Type.String({ minLength: 1 })),
  createdAt: Type.String({ minLength: 1 }),
  updatedAt: Type.String({ minLength: 1 })
};

const JOB_RECORD_SCHEMA = Type.Union([
  Type.Object({ ...JOB_BASE_PROPERTIES, kind: Type.Literal("queued") }, { additionalProperties: false }),
  Type.Object({ ...JOB_BASE_PROPERTIES, kind: Type.Literal("running") }, { additionalProperties: false }),
  Type.Object({ ...JOB_BASE_PROPERTIES, kind: Type.Literal("cancel_requested") }, { additionalProperties: false }),
  Type.Object(
    {
      ...JOB_BASE_PROPERTIES,
      kind: Type.Literal("completed"),
      resultPath: Type.String({ minLength: 1 })
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...JOB_BASE_PROPERTIES,
      kind: Type.Literal("failed"),
      error: Type.String({ minLength: 1 })
    },
    { additionalProperties: false }
  ),
  Type.Object({ ...JOB_BASE_PROPERTIES, kind: Type.Literal("cancelled") }, { additionalProperties: false })
]);

const validateJobRecord = Compile(JOB_RECORD_SCHEMA);

export type StoredJob = Static<typeof JOB_RECORD_SCHEMA>;
export type QueuedJob = Extract<StoredJob, { kind: "queued" }>;

type CreateQueuedJobParams = {
  task: string;
  childCommand: string;
  childArgs: string[];
  model?: string;
  thinkingLevel?: string;
};

type ReadJobParams = {
  jobId: string;
};

type CompleteJobParams = {
  jobId: string;
  resultPath: string;
};

type FailJobParams = {
  jobId: string;
  error: string;
};

type CreateJobStoreParams = {
  agentDirectory: string;
  workspacePath: string;
};

export type JobStore = {
  createQueuedJob(params: CreateQueuedJobParams): Promise<QueuedJob>;
  readJob(params: ReadJobParams): Promise<StoredJob>;
  listJobs(): Promise<StoredJob[]>;
  markRunning(params: ReadJobParams): Promise<StoredJob>;
  markCompleted(params: CompleteJobParams): Promise<StoredJob>;
  markFailed(params: FailJobParams): Promise<StoredJob>;
  markCancelled(params: ReadJobParams): Promise<StoredJob>;
  requestCancellation(params: ReadJobParams): Promise<StoredJob>;
  isCancellationRequested(params: ReadJobParams): Promise<boolean>;
};

function summarizeTask(task: string): string {
  const summary = task.replace(/\s+/gu, " ").trim();
  return summary.slice(0, MAX_TASK_SUMMARY_LENGTH);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function writeJobRecord(job: StoredJob): Promise<void> {
  const recordPath = join(job.directoryPath, JOB_RECORD_FILE);
  const temporaryPath = join(job.directoryPath, `${JOB_RECORD_FILE}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(job)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, recordPath);
}

function parseJobRecord(value: unknown): StoredJob {
  if (!validateJobRecord.Check(value)) {
    const firstError = validateJobRecord.Errors(value)[0];
    throw new Error(`Subagent job record is invalid${firstError ? `: ${firstError.message}` : "."}`);
  }
  return value;
}

export async function createJobStore({ agentDirectory, workspacePath }: CreateJobStoreParams): Promise<JobStore> {
  const canonicalWorkspacePath = await realpath(workspacePath);
  const workspaceKey = createHash("sha256").update(canonicalWorkspacePath).digest("hex");
  const workspaceDirectory = join(agentDirectory, JOB_STORE_DIRECTORY, workspaceKey);
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });

  async function readJob({ jobId }: ReadJobParams): Promise<StoredJob> {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error(`Subagent job not found: ${jobId}`);
    const recordPath = join(workspaceDirectory, jobId, JOB_RECORD_FILE);
    let serialized: string;
    try {
      serialized = await readFile(recordPath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) throw new Error(`Subagent job not found: ${jobId}`, { cause: error });
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new Error(`Subagent job record is invalid: ${jobId}`, { cause: error });
    }
    const job = parseJobRecord(value);
    if (job.id !== jobId || job.workspacePath !== canonicalWorkspacePath) {
      throw new Error(`Subagent job record does not belong to this workspace: ${jobId}`);
    }
    if ((job.kind === "queued" || job.kind === "running") && (await isCancellationRequested({ jobId }))) {
      return { ...job, kind: "cancel_requested" };
    }
    return job;
  }

  async function isCancellationRequested({ jobId }: ReadJobParams): Promise<boolean> {
    if (!JOB_ID_PATTERN.test(jobId)) return false;
    try {
      await access(join(workspaceDirectory, jobId, JOB_CANCELLATION_FILE));
      return true;
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
  }

  return {
    async createQueuedJob({
      task,
      childCommand,
      childArgs,
      model,
      thinkingLevel
    }: CreateQueuedJobParams): Promise<QueuedJob> {
      const id = randomUUID();
      const directoryPath = join(workspaceDirectory, id);
      const taskPath = join(directoryPath, JOB_TASK_FILE);
      const timestamp = new Date().toISOString();
      await mkdir(directoryPath, { mode: 0o700 });
      await writeFile(taskPath, task, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const job: QueuedJob = {
        version: 1,
        id,
        kind: "queued",
        workspacePath: canonicalWorkspacePath,
        directoryPath,
        taskPath,
        taskSummary: summarizeTask(task),
        childCommand,
        childArgs: [...childArgs],
        ...(model === undefined ? {} : { model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await writeJobRecord(job);
      return job;
    },
    readJob,
    async listJobs(): Promise<StoredJob[]> {
      const entries = await readdir(workspaceDirectory, { withFileTypes: true });
      const jobs: StoredJob[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
        jobs.push(await readJob({ jobId: entry.name }));
      }
      jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return jobs;
    },
    async markRunning({ jobId }: ReadJobParams): Promise<StoredJob> {
      const job = await readJob({ jobId });
      if (job.kind === "cancel_requested") return job;
      if (job.kind !== "queued") throw new Error(`Cannot start subagent job from ${job.kind}: ${jobId}`);
      const running: StoredJob = { ...job, kind: "running", updatedAt: new Date().toISOString() };
      await writeJobRecord(running);
      return running;
    },
    async markCompleted({ jobId, resultPath }: CompleteJobParams): Promise<StoredJob> {
      const job = await readJob({ jobId });
      if (job.kind !== "running") throw new Error(`Cannot complete subagent job from ${job.kind}: ${jobId}`);
      const completed: StoredJob = {
        ...job,
        kind: "completed",
        resultPath,
        updatedAt: new Date().toISOString()
      };
      await writeJobRecord(completed);
      return completed;
    },
    async markFailed({ jobId, error }: FailJobParams): Promise<StoredJob> {
      const job = await readJob({ jobId });
      if (job.kind !== "queued" && job.kind !== "running") {
        throw new Error(`Cannot fail subagent job from ${job.kind}: ${jobId}`);
      }
      const failed: StoredJob = { ...job, kind: "failed", error, updatedAt: new Date().toISOString() };
      await writeJobRecord(failed);
      return failed;
    },
    async markCancelled({ jobId }: ReadJobParams): Promise<StoredJob> {
      const job = await readJob({ jobId });
      if (job.kind !== "queued" && job.kind !== "running" && job.kind !== "cancel_requested") {
        throw new Error(`Cannot cancel subagent job from ${job.kind}: ${jobId}`);
      }
      const cancelled: StoredJob = { ...job, kind: "cancelled", updatedAt: new Date().toISOString() };
      await writeJobRecord(cancelled);
      return cancelled;
    },
    async requestCancellation({ jobId }: ReadJobParams): Promise<StoredJob> {
      const job = await readJob({ jobId });
      if (job.kind === "completed" || job.kind === "failed" || job.kind === "cancelled") return job;
      const cancellationPath = join(job.directoryPath, JOB_CANCELLATION_FILE);
      try {
        await writeFile(cancellationPath, "cancel requested\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      return { ...job, kind: "cancel_requested" };
    },
    isCancellationRequested
  };
}
