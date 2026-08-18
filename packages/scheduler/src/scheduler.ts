import { type Static, Type } from "typebox";

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const DEFAULT_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const SECONDS_PER_MINUTE = 60;

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

export type SchedulerKind = "launchd" | "systemd";
export type ScheduleInput = Static<typeof SCHEDULE_SCHEMA>;
export type CalendarSchedule = {
  kind: "calendar";
  hour: number;
  minute: number;
  weekdays?: Weekday[];
};
export type IntervalSchedule = {
  kind: "interval";
  intervalSeconds: number;
};
export type Schedule = CalendarSchedule | IntervalSchedule;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type Weekday = (typeof WEEKDAYS)[number];
export type ScheduledTask = {
  id: string;
  nativeId?: string;
  scheduler: SchedulerKind;
  schedule: Schedule;
  workingDirectory: string;
  tools: BuiltinToolName[];
  skills: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  createdAt: string;
  instructionsPath: string;
  stdoutPath: string;
  stderrPath: string;
};

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

export function getSchedulerKind(platform: NodeJS.Platform): SchedulerKind {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new Error(`opi-scheduler is unsupported on ${platform}.`);
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
