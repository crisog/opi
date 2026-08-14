import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const DEFAULT_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const SECONDS_PER_MINUTE = 60;

const SCHEDULER_KINDS = ["launchd", "systemd"] as const;

const SCHEDULER_KIND_SCHEMA = Type.Unsafe<(typeof SCHEDULER_KINDS)[number]>({
  type: "string",
  enum: SCHEDULER_KINDS
});

const BUILTIN_TOOL_NAME_SCHEMA = Type.Unsafe<(typeof BUILTIN_TOOL_NAMES)[number]>({
  type: "string",
  enum: BUILTIN_TOOL_NAMES
});

const THINKING_LEVEL_SCHEMA = Type.Unsafe<(typeof THINKING_LEVELS)[number]>({
  type: "string",
  enum: THINKING_LEVELS
});

const WEEKDAY_SCHEMA = Type.Unsafe<(typeof WEEKDAYS)[number]>({
  type: "integer",
  enum: WEEKDAYS
});

export const SCHEDULE_SCHEMA = Type.Object(
  {
    hour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
    minute: Type.Optional(Type.Integer({ minimum: 0, maximum: 59 })),
    weekdays: Type.Optional(Type.Array(WEEKDAY_SCHEMA, { minItems: 1, uniqueItems: true })),
    intervalSeconds: Type.Optional(Type.Integer({ minimum: 1 }))
  },
  { additionalProperties: false }
);

const CALENDAR_SCHEDULE_SCHEMA = Type.Object(
  {
    kind: Type.Literal("calendar"),
    hour: Type.Integer({ minimum: 0, maximum: 23 }),
    minute: Type.Integer({ minimum: 0, maximum: 59 }),
    weekdays: Type.Optional(Type.Array(WEEKDAY_SCHEMA, { minItems: 1, uniqueItems: true }))
  },
  { additionalProperties: false }
);

const INTERVAL_SCHEDULE_SCHEMA = Type.Object(
  {
    kind: Type.Literal("interval"),
    intervalSeconds: Type.Integer({ minimum: 1 })
  },
  { additionalProperties: false }
);

const STORED_SCHEDULE_SCHEMA = Type.Union([CALENDAR_SCHEDULE_SCHEMA, INTERVAL_SCHEDULE_SCHEMA]);

const SCHEDULED_TASK_SCHEMA = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    scheduler: SCHEDULER_KIND_SCHEMA,
    schedule: STORED_SCHEDULE_SCHEMA,
    workingDirectory: Type.String({ minLength: 1 }),
    tools: Type.Array(BUILTIN_TOOL_NAME_SCHEMA, { minItems: 1, uniqueItems: true }),
    skills: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinkingLevel: Type.Optional(THINKING_LEVEL_SCHEMA),
    createdAt: Type.String({ minLength: 1 }),
    instructionsPath: Type.String({ minLength: 1 }),
    stdoutPath: Type.String({ minLength: 1 }),
    stderrPath: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

const validateScheduledTask = Compile(SCHEDULED_TASK_SCHEMA);

export type SchedulerKind = Static<typeof SCHEDULER_KIND_SCHEMA>;
export type ScheduleInput = Static<typeof SCHEDULE_SCHEMA>;
export type CalendarSchedule = Static<typeof CALENDAR_SCHEDULE_SCHEMA>;
export type IntervalSchedule = Static<typeof INTERVAL_SCHEDULE_SCHEMA>;
export type Schedule = CalendarSchedule | IntervalSchedule;
export type BuiltinToolName = Static<typeof BUILTIN_TOOL_NAME_SCHEMA>;
export type ThinkingLevel = Static<typeof THINKING_LEVEL_SCHEMA>;
export type Weekday = Static<typeof WEEKDAY_SCHEMA>;
export type ScheduledTask = Static<typeof SCHEDULED_TASK_SCHEMA>;

export type PiInvocation = {
  command: string;
  args: string[];
  environment: {
    PATH: string;
    PI_CODING_AGENT_DIR: string;
  };
};

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
};

type ExecuteCommandParams = {
  command: string;
  args: string[];
};

export type ExecuteCommand = (params: ExecuteCommandParams) => Promise<CommandResult>;

export type TaskPaths = {
  directory: string;
  metadata: string;
  instructions: string;
  stdout: string;
  stderr: string;
};

type CreateTaskStateParams = {
  schedulerRoot: string;
  task: ScheduledTask;
  instructions: string;
};

type BuildTaskPathsParams = {
  schedulerRoot: string;
  id: string;
};

export function getSchedulerKind(platform: NodeJS.Platform): SchedulerKind {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new Error(`opi-scheduler is unsupported on ${platform}.`);
}

export function buildTaskPaths({ schedulerRoot, id }: BuildTaskPathsParams): TaskPaths {
  const directory = join(schedulerRoot, "tasks", id);
  return {
    directory,
    metadata: join(directory, "task.json"),
    instructions: join(directory, "instructions.md"),
    stdout: join(directory, "stdout.log"),
    stderr: join(directory, "stderr.log")
  };
}

export async function createTaskState({
  schedulerRoot,
  task,
  instructions
}: CreateTaskStateParams): Promise<TaskPaths> {
  const paths = buildTaskPaths({ schedulerRoot, id: task.id });
  if (existsSync(paths.directory)) throw new Error(`Scheduled task already exists: ${task.id}`);

  await mkdir(join(schedulerRoot, "tasks"), { recursive: true });
  await mkdir(paths.directory);
  try {
    await Promise.all([
      writeFile(paths.instructions, `${instructions.trim()}\n`, { encoding: "utf8", mode: 0o600 }),
      writeFile(paths.metadata, `${JSON.stringify(task, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    ]);
    return paths;
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true });
    throw new Error(`Could not persist scheduled task ${task.id}: ${formatError(error)}`, { cause: error });
  }
}

export async function readScheduledTask(metadataPath: string): Promise<ScheduledTask> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read scheduled task metadata at ${metadataPath}: ${formatError(error)}`, {
      cause: error
    });
  }

  if (!validateScheduledTask.Check(value)) {
    const firstError = validateScheduledTask.Errors(value)[0];
    throw new Error(
      `Invalid scheduled task metadata at ${metadataPath}${firstError ? `: ${firstError.message}` : "."}`
    );
  }
  return value;
}

export async function listScheduledTasks(schedulerRoot: string): Promise<ScheduledTask[]> {
  const tasksDirectory = join(schedulerRoot, "tasks");
  if (!existsSync(tasksDirectory)) return [];

  const entries = await readdir(tasksDirectory, { withFileTypes: true });
  const tasks: ScheduledTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadataPath = join(tasksDirectory, entry.name, "task.json");
    if (!existsSync(metadataPath)) {
      throw new Error(`Scheduled task directory is missing task.json: ${basename(entry.name)}`);
    }
    tasks.push(await readScheduledTask(metadataPath));
  }
  tasks.sort((left, right) => left.id.localeCompare(right.id));
  return tasks;
}

export function parseSchedule(raw: ScheduleInput): Schedule {
  if (raw.intervalSeconds !== undefined) {
    if (raw.hour !== undefined || raw.minute !== undefined || raw.weekdays !== undefined) {
      throw new Error("schedule cannot have both intervalSeconds and hour/minute/weekdays");
    }
    return { kind: "interval", intervalSeconds: raw.intervalSeconds };
  }
  if (raw.hour !== undefined && raw.minute !== undefined) {
    if (raw.weekdays !== undefined) {
      return { kind: "calendar", hour: raw.hour, minute: raw.minute, weekdays: raw.weekdays };
    }
    return { kind: "calendar", hour: raw.hour, minute: raw.minute };
  }
  throw new Error("schedule must have either intervalSeconds or hour+minute");
}

export function formatSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    return formatIntervalSchedule(schedule.intervalSeconds);
  }
  return formatCalendarSchedule(schedule.hour, schedule.minute, schedule.weekdays);
}

function formatIntervalSchedule(intervalSeconds: number): string {
  if (intervalSeconds < SECONDS_PER_MINUTE) return `every ${intervalSeconds}s`;
  const minutes = Math.floor(intervalSeconds / SECONDS_PER_MINUTE);
  const seconds = intervalSeconds % SECONDS_PER_MINUTE;
  if (seconds === 0) return `every ${minutes}min`;
  return `every ${minutes}min ${seconds}s`;
}

function formatCalendarSchedule(hour: number, minute: number, weekdays: number[] | undefined): string {
  const time = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  if (!weekdays) return `daily at ${time}`;
  return `${weekdays.join(",")} at ${time}`;
}

export function formatCommandFailure(result: CommandResult): string {
  if (result.killed) return "command was cancelled";
  return result.stderr.trim() || `command exited with code ${result.code}`;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
