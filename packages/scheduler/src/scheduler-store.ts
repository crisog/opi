import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { BuiltinToolName, Schedule, SchedulerKind, ThinkingLevel } from "./scheduler.ts";

const STORE_VERSION = 1;
const SCHEDULER_DIRECTORY = "scheduler";
const WORKSPACES_DIRECTORY = "workspaces";
const TASKS_DIRECTORY = "tasks";
const TASK_RECORD_FILE = "task.json";
const INSTRUCTIONS_FILE = "instructions.md";
const LATEST_RUN_FILE = "latest-run.json";
const RESULT_FILE = "result.md";
const STDOUT_FILE = "stdout.log";
const STDERR_FILE = "stderr.log";
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NATIVE_WORKSPACE_KEY_LENGTH = 12;
const MAX_INSTRUCTIONS_SUMMARY_LENGTH = 160;

const SCHEDULE_SCHEMA = Type.Unsafe<Schedule>({
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { const: "calendar" },
        hour: { type: "integer", minimum: 0, maximum: 23 },
        minute: { type: "integer", minimum: 0, maximum: 59 },
        weekdays: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 }, minItems: 1, uniqueItems: true }
      },
      required: ["kind", "hour", "minute"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        kind: { const: "interval" },
        intervalSeconds: { type: "integer", minimum: 1 }
      },
      required: ["kind", "intervalSeconds"],
      additionalProperties: false
    }
  ]
});

const TOOL_SCHEMA = Type.Unsafe<BuiltinToolName>({
  type: "string",
  enum: ["read", "bash", "edit", "write", "grep", "find", "ls"]
});

const TASK_SCHEMA = Type.Object(
  {
    version: Type.Literal(STORE_VERSION),
    id: Type.String({ minLength: 1 }),
    nativeId: Type.String({ minLength: 1 }),
    scheduler: Type.Unsafe<SchedulerKind>({ type: "string", enum: ["launchd", "systemd"] }),
    schedule: SCHEDULE_SCHEMA,
    workspacePath: Type.String({ minLength: 1 }),
    workingDirectory: Type.String({ minLength: 1 }),
    workspaceKey: Type.String({ minLength: 1 }),
    directoryPath: Type.String({ minLength: 1 }),
    instructionsPath: Type.String({ minLength: 1 }),
    instructionsSummary: Type.String({ minLength: 1, maxLength: MAX_INSTRUCTIONS_SUMMARY_LENGTH }),
    latestRunPath: Type.String({ minLength: 1 }),
    resultPath: Type.String({ minLength: 1 }),
    stdoutPath: Type.String({ minLength: 1 }),
    stderrPath: Type.String({ minLength: 1 }),
    tools: Type.Array(TOOL_SCHEMA, { minItems: 1, uniqueItems: true }),
    skills: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinkingLevel: Type.Optional(
      Type.Unsafe<ThinkingLevel>({
        type: "string",
        enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      })
    ),
    childCommand: Type.String({ minLength: 1 }),
    childArgs: Type.Array(Type.String()),
    environment: Type.Object(
      {
        PATH: Type.String({ minLength: 1 }),
        PI_CODING_AGENT_DIR: Type.String({ minLength: 1 })
      },
      { additionalProperties: false }
    ),
    createdAt: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

const RUN_BASE_PROPERTIES = {
  version: Type.Literal(STORE_VERSION),
  taskId: Type.String({ minLength: 1 }),
  startedAt: Type.String({ minLength: 1 })
};

const LATEST_RUN_SCHEMA = Type.Union([
  Type.Object({ ...RUN_BASE_PROPERTIES, kind: Type.Literal("running") }, { additionalProperties: false }),
  Type.Object(
    {
      ...RUN_BASE_PROPERTIES,
      kind: Type.Literal("completed"),
      finishedAt: Type.String({ minLength: 1 }),
      resultPath: Type.String({ minLength: 1 })
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...RUN_BASE_PROPERTIES,
      kind: Type.Literal("failed"),
      finishedAt: Type.String({ minLength: 1 }),
      error: Type.String({ minLength: 1 })
    },
    { additionalProperties: false }
  )
]);

const validateTask = Compile(TASK_SCHEMA);
const validateLatestRun = Compile(LATEST_RUN_SCHEMA);

export type StoredSchedulerTask = Static<typeof TASK_SCHEMA>;
export type LatestSchedulerRun = Static<typeof LATEST_RUN_SCHEMA>;

type CreateTaskParams = {
  id: string;
  scheduler: StoredSchedulerTask["scheduler"];
  schedule: StoredSchedulerTask["schedule"];
  instructions: string;
  tools: StoredSchedulerTask["tools"];
  skills: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  childCommand: string;
  childArgs: string[];
  environment: StoredSchedulerTask["environment"];
};

type TaskIdParams = {
  id: string;
};

type MarkRunParams = TaskIdParams & {
  startedAt: string;
};

type MarkRunCompletedParams = MarkRunParams & {
  resultPath: string;
};

type MarkRunFailedParams = MarkRunParams & {
  error: string;
};

type CreateSchedulerStoreParams = {
  agentDirectory: string;
  workspacePath: string;
};

export type SchedulerStore = {
  workspaceKey: string;
  getTaskPaths(params: TaskIdParams): {
    instructionsPath: string;
  };
  createTask(params: CreateTaskParams): Promise<StoredSchedulerTask>;
  readTask(params: TaskIdParams): Promise<StoredSchedulerTask>;
  listTasks(): Promise<StoredSchedulerTask[]>;
  removeTaskState(params: TaskIdParams): Promise<void>;
  readLatestRun(params: TaskIdParams): Promise<LatestSchedulerRun | null>;
  markRunRunning(params: MarkRunParams): Promise<LatestSchedulerRun>;
  markRunCompleted(params: MarkRunCompletedParams): Promise<LatestSchedulerRun>;
  markRunFailed(params: MarkRunFailedParams): Promise<LatestSchedulerRun>;
};

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function summarizeInstructions(instructions: string): string {
  return instructions.replace(/\s+/gu, " ").trim().slice(0, MAX_INSTRUCTIONS_SUMMARY_LENGTH);
}

async function writeJsonAtomic({ path, value }: { path: string; value: unknown }): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await rename(temporaryPath, path);
}

function parseTask(value: unknown): StoredSchedulerTask {
  if (!validateTask.Check(value)) {
    const firstError = validateTask.Errors(value)[0];
    throw new Error(`Scheduled task record is invalid${firstError ? `: ${firstError.message}` : "."}`);
  }
  return value;
}

function parseLatestRun(value: unknown): LatestSchedulerRun {
  if (!validateLatestRun.Check(value)) {
    const firstError = validateLatestRun.Errors(value)[0];
    throw new Error(`Scheduled run record is invalid${firstError ? `: ${firstError.message}` : "."}`);
  }
  return value;
}

export async function createSchedulerStore({
  agentDirectory,
  workspacePath
}: CreateSchedulerStoreParams): Promise<SchedulerStore> {
  const canonicalWorkspacePath = await realpath(workspacePath);
  const workspaceKey = createHash("sha256").update(canonicalWorkspacePath).digest("hex");
  const tasksDirectory = join(agentDirectory, SCHEDULER_DIRECTORY, WORKSPACES_DIRECTORY, workspaceKey, TASKS_DIRECTORY);
  await mkdir(tasksDirectory, { recursive: true, mode: 0o700 });

  async function readTask({ id }: TaskIdParams): Promise<StoredSchedulerTask> {
    if (!TASK_ID_PATTERN.test(id)) throw new Error(`Scheduled task does not exist: ${id}`);
    let serialized: string;
    try {
      serialized = await readFile(join(tasksDirectory, id, TASK_RECORD_FILE), "utf8");
    } catch (error) {
      if (isFileNotFound(error)) throw new Error(`Scheduled task does not exist: ${id}`, { cause: error });
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new Error(`Scheduled task record is invalid: ${id}`, { cause: error });
    }
    const task = parseTask(value);
    const directoryPath = join(tasksDirectory, id);
    const nativeId = `${workspaceKey.slice(0, NATIVE_WORKSPACE_KEY_LENGTH)}-${id}`;
    const hasInvalidIdentity =
      task.id !== id ||
      task.nativeId !== nativeId ||
      task.workspacePath !== canonicalWorkspacePath ||
      task.workingDirectory !== canonicalWorkspacePath ||
      task.workspaceKey !== workspaceKey;
    const hasInvalidPath =
      task.directoryPath !== directoryPath ||
      task.instructionsPath !== join(directoryPath, INSTRUCTIONS_FILE) ||
      task.latestRunPath !== join(directoryPath, LATEST_RUN_FILE) ||
      task.resultPath !== join(directoryPath, RESULT_FILE) ||
      task.stdoutPath !== join(directoryPath, STDOUT_FILE) ||
      task.stderrPath !== join(directoryPath, STDERR_FILE);
    if (hasInvalidIdentity || hasInvalidPath) {
      throw new Error(`Scheduled task does not belong to this workspace: ${id}`);
    }
    return task;
  }

  async function readLatestRun({ id }: TaskIdParams): Promise<LatestSchedulerRun | null> {
    const task = await readTask({ id });
    let serialized: string;
    try {
      serialized = await readFile(task.latestRunPath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new Error(`Scheduled run record is invalid: ${id}`, { cause: error });
    }
    const run = parseLatestRun(value);
    if (run.taskId !== id) throw new Error(`Scheduled run does not belong to task: ${id}`);
    if (run.kind === "completed" && run.resultPath !== task.resultPath) {
      throw new Error(`Scheduled run result does not belong to task: ${id}`);
    }
    return run;
  }

  async function writeRun(run: LatestSchedulerRun): Promise<LatestSchedulerRun> {
    const task = await readTask({ id: run.taskId });
    await writeJsonAtomic({ path: task.latestRunPath, value: run });
    return run;
  }

  return {
    workspaceKey,
    getTaskPaths({ id }: TaskIdParams): { instructionsPath: string } {
      return { instructionsPath: join(tasksDirectory, id, INSTRUCTIONS_FILE) };
    },
    async createTask({
      id,
      scheduler,
      schedule,
      instructions,
      tools,
      skills,
      model,
      thinkingLevel,
      childCommand,
      childArgs,
      environment
    }: CreateTaskParams): Promise<StoredSchedulerTask> {
      if (!TASK_ID_PATTERN.test(id)) throw new Error(`Invalid scheduled task ID: ${id}`);
      const directoryPath = join(tasksDirectory, id);
      const instructionsPath = join(directoryPath, INSTRUCTIONS_FILE);
      await mkdir(directoryPath, { mode: 0o700 });
      const task: StoredSchedulerTask = {
        version: STORE_VERSION,
        id,
        nativeId: `${workspaceKey.slice(0, NATIVE_WORKSPACE_KEY_LENGTH)}-${id}`,
        scheduler,
        schedule,
        workspacePath: canonicalWorkspacePath,
        workingDirectory: canonicalWorkspacePath,
        workspaceKey,
        directoryPath,
        instructionsPath,
        instructionsSummary: summarizeInstructions(instructions),
        latestRunPath: join(directoryPath, LATEST_RUN_FILE),
        resultPath: join(directoryPath, RESULT_FILE),
        stdoutPath: join(directoryPath, STDOUT_FILE),
        stderrPath: join(directoryPath, STDERR_FILE),
        tools: [...tools],
        skills: [...skills],
        ...(model === undefined ? {} : { model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        childCommand,
        childArgs: [...childArgs],
        environment,
        createdAt: new Date().toISOString()
      };
      try {
        await writeFile(instructionsPath, `${instructions.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await writeJsonAtomic({ path: join(directoryPath, TASK_RECORD_FILE), value: task });
      } catch (error) {
        await rm(directoryPath, { recursive: true, force: true });
        throw error;
      }
      return task;
    },
    readTask,
    async listTasks(): Promise<StoredSchedulerTask[]> {
      const entries = await readdir(tasksDirectory, { withFileTypes: true });
      const tasks: StoredSchedulerTask[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
        tasks.push(await readTask({ id: entry.name }));
      }
      tasks.sort((left, right) => left.id.localeCompare(right.id));
      return tasks;
    },
    async removeTaskState({ id }: TaskIdParams): Promise<void> {
      const task = await readTask({ id });
      await rm(task.directoryPath, { recursive: true, force: true });
    },
    readLatestRun,
    markRunRunning({ id, startedAt }: MarkRunParams): Promise<LatestSchedulerRun> {
      return writeRun({ version: STORE_VERSION, taskId: id, kind: "running", startedAt });
    },
    markRunCompleted({ id, startedAt, resultPath }: MarkRunCompletedParams): Promise<LatestSchedulerRun> {
      return writeRun({
        version: STORE_VERSION,
        taskId: id,
        kind: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        resultPath
      });
    },
    markRunFailed({ id, startedAt, error }: MarkRunFailedParams): Promise<LatestSchedulerRun> {
      return writeRun({
        version: STORE_VERSION,
        taskId: id,
        kind: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error
      });
    }
  };
}
