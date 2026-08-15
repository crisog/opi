import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
  type ExtensionAPI
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installLaunchdTask, removeLaunchdTask } from "./launchd.ts";
import {
  BUILTIN_TOOL_NAMES,
  DEFAULT_TOOL_NAMES,
  SCHEDULE_SCHEMA,
  THINKING_LEVELS,
  buildTaskPaths,
  createTaskState,
  formatCommandFailure,
  formatError,
  formatSchedule,
  getSchedulerKind,
  listScheduledTasks,
  parseSchedule,
  readScheduledTask,
  type BuiltinToolName,
  type ExecuteCommand,
  type PiInvocation,
  type Schedule,
  type ScheduleInput,
  type ScheduledTask,
  type ThinkingLevel
} from "./scheduler.ts";
import { installSystemdTask, removeSystemdTask } from "./systemd.ts";

const ACTIONS = ["create", "list", "remove"] as const;
const MAX_ID_LENGTH = 64;
const MAX_INSTRUCTIONS_LENGTH = 20_000;
const MAX_SKILL_NAME_LENGTH = 64;
const ID_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const ACTION_SCHEMA = Type.Unsafe<(typeof ACTIONS)[number]>({
  type: "string",
  enum: ACTIONS
});

const BUILTIN_TOOL_SCHEMA = Type.Unsafe<BuiltinToolName>({
  type: "string",
  enum: BUILTIN_TOOL_NAMES
});

const THINKING_LEVEL_SCHEMA = Type.Unsafe<ThinkingLevel>({
  type: "string",
  enum: THINKING_LEVELS
});

const SCHEDULER_PARAMS = Type.Object(
  {
    action: ACTION_SCHEMA,
    id: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_ID_LENGTH,
        pattern: ID_PATTERN,
        description: "Stable lowercase task ID"
      })
    ),
    instructions: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_INSTRUCTIONS_LENGTH,
        description: "Self-contained instructions for the scheduled Pi run"
      })
    ),
    schedule: Type.Optional(SCHEDULE_SCHEMA),
    tools: Type.Optional(
      Type.Array(BUILTIN_TOOL_SCHEMA, {
        minItems: 1,
        uniqueItems: true,
        description: "Built-in tools available to the run; defaults to read, grep, find, ls, and bash"
      })
    ),
    skills: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: MAX_SKILL_NAME_LENGTH,
          pattern: SKILL_NAME_PATTERN,
          description: "Required skill name without the skill: prefix"
        }),
        { uniqueItems: true }
      )
    ),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Pi model pattern or provider/model ID; defaults to the current model"
      })
    ),
    thinkingLevel: Type.Optional(THINKING_LEVEL_SCHEMA),
    notify: Type.Optional(
      Type.Boolean({
        description: "Fire a desktop notification when the scheduled task completes"
      })
    )
  },
  { additionalProperties: false }
);

type ChildModel = {
  provider: string;
  id: string;
};

type RequiredSkill = {
  name: string;
  path: string;
};

type BuildScheduledPiArgsParams = {
  instructionsPath: string;
  isProjectTrusted: boolean;
  model?: string;
  skills: RequiredSkill[];
  thinkingLevel?: ThinkingLevel;
  tools: BuiltinToolName[];
};

type ResolveRequiredSkillsParams = {
  commands: ReturnType<ExtensionAPI["getCommands"]>;
  names: string[];
};

type NativeScheduler =
  | {
      kind: "launchd";
      userId: number;
    }
  | {
      kind: "systemd";
    };

type CreateScheduledTaskParams = {
  executeCommand: ExecuteCommand;
  schedulerRoot: string;
  nativeScheduler: NativeScheduler;
  id: string;
  instructions: string;
  schedule: Schedule;
  tools: BuiltinToolName[];
  skills: RequiredSkill[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  notify: boolean;
  workingDirectory: string;
  isProjectTrusted: boolean;
};

type RemoveScheduledTaskParams = {
  executeCommand: ExecuteCommand;
  schedulerRoot: string;
  nativeScheduler: NativeScheduler;
  id: string;
};

export function buildScheduledPiArgs({
  instructionsPath,
  isProjectTrusted,
  model,
  skills,
  thinkingLevel,
  tools
}: BuildScheduledPiArgsParams): string[] {
  const args = [
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    tools.join(","),
    isProjectTrusted ? "--approve" : "--no-approve"
  ];
  for (const skill of skills) args.push("--skill", skill.path);
  if (skills.length > 0) args.push("--append-system-prompt", buildRequiredSkillsPrompt(skills));
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  args.push(`@${instructionsPath}`);
  return args;
}

function buildRequiredSkillsPrompt(skills: RequiredSkill[]): string {
  const skillLines = skills.map((skill) => `- ${skill.name}: ${skill.path}`).join("\n");
  return `You must use the following skills for this scheduled task:\n${skillLines}\nRead each required SKILL.md in full before starting, follow its instructions, and resolve relative references from its containing directory.`;
}

export function getPiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  const environment = {
    PATH: getScheduledPath(),
    PI_CODING_AGENT_DIR: getAgentDir()
  };
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args], environment };
  }

  const executableName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/u.test(executableName);
  if (!isGenericRuntime) return { command: process.execPath, args, environment };
  return { command: "pi", args, environment };
}

export function resolveRequiredSkills({ commands, names }: ResolveRequiredSkillsParams): RequiredSkill[] {
  const skills: RequiredSkill[] = [];
  for (const name of names) {
    const command = commands.find((candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`);
    if (!command) throw new Error(`Required scheduler skill is not available: ${name}`);
    skills.push({ name, path: command.sourceInfo.path });
  }
  return skills;
}

export default function registerScheduler(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "scheduler",
    label: "Scheduler",
    description: "Create, list, or remove recurring Pi tasks using launchd on macOS or systemd user timers on Linux.",
    promptSnippet: "Manage recurring native scheduled Pi tasks",
    promptGuidelines: [
      "Use scheduler when the user asks Pi to run recurring unattended checks.",
      "Give scheduler self-contained instructions that explain what to inspect and what outcome to produce.",
      "Grant scheduler write or edit only when the scheduled task must modify files."
    ],
    parameters: SCHEDULER_PARAMS,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const nativeScheduler = getNativeScheduler(process.platform);
      const executeCommand: ExecuteCommand = async ({ command, args }) =>
        pi.exec(command, args, { cwd: ctx.cwd, signal });
      await assertSchedulerAvailable({ executeCommand, nativeScheduler, signal });

      if (params.action === "list") {
        const tasks = await listScheduledTasks(join(getAgentDir(), "scheduler"));
        const text = tasks.length === 0 ? "No scheduled tasks." : tasks.map(formatScheduledTask).join("\n\n");
        return {
          content: [{ type: "text", text: await formatOutput(text) }],
          details: { action: params.action, count: tasks.length }
        };
      }

      const id = requireValue({ value: params.id, name: "id", action: params.action });
      const schedulerRoot = join(getAgentDir(), "scheduler");
      if (params.action === "remove") {
        await removeScheduledTask({ executeCommand, schedulerRoot, nativeScheduler, id });
        return {
          content: [{ type: "text", text: `Removed scheduled task: ${id}` }],
          details: { action: params.action, id }
        };
      }

      const instructions = requireValue({
        value: params.instructions,
        name: "instructions",
        action: params.action
      });
      const schedule = requireSchedule(params.schedule);
      const notify = params.notify ?? false;
      const skills = resolveRequiredSkills({ commands: pi.getCommands(), names: params.skills ?? [] });
      const tools = params.tools ? [...params.tools] : [...DEFAULT_TOOL_NAMES];
      const model = params.model ?? formatChildModel(ctx.model);
      const thinkingLevel = params.thinkingLevel ?? ctx.thinkingLevel;

      onUpdate?.({
        content: [{ type: "text", text: `Creating scheduled task ${id}...` }],
        details: { action: params.action, id, status: "creating" }
      });
      const task = await createScheduledTask({
        executeCommand,
        schedulerRoot,
        nativeScheduler,
        id,
        instructions,
        schedule,
        tools,
        skills,
        model,
        thinkingLevel,
        notify,
        workingDirectory: ctx.cwd,
        isProjectTrusted: ctx.isProjectTrusted()
      });
      return {
        content: [{ type: "text", text: `Created scheduled task: ${task.id}\n${formatScheduledTask(task)}` }],
        details: { action: params.action, id, status: "created" }
      };
    }
  });
}

async function createScheduledTask({
  executeCommand,
  schedulerRoot,
  nativeScheduler,
  id,
  instructions,
  schedule,
  tools,
  skills,
  model,
  thinkingLevel,
  workingDirectory,
  notify,
  isProjectTrusted
}: CreateScheduledTaskParams): Promise<ScheduledTask> {
  const paths = buildTaskPaths({ schedulerRoot, id });
  const task: ScheduledTask = {
    id,
    scheduler: nativeScheduler.kind,
    schedule,
    workingDirectory,
    tools,
    skills: skills.map((skill) => skill.name),
    model,
    thinkingLevel,
    notify,
    createdAt: new Date().toISOString(),
    instructionsPath: paths.instructions,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr
  };

  let hasCreatedState = false;
  try {
    await createTaskState({ schedulerRoot, task, instructions });
    hasCreatedState = true;
    const args = buildScheduledPiArgs({
      instructionsPath: paths.instructions,
      isProjectTrusted,
      model,
      skills,
      thinkingLevel,
      tools
    });
    const invocation = getPiInvocation(args);

    if (nativeScheduler.kind === "launchd") {
      await installLaunchdTask({
        task,
        invocation,
        notify,
        executeCommand,
        launchAgentsDirectory: join(homedir(), "Library", "LaunchAgents"),
        userId: nativeScheduler.userId
      });
    } else {
      await installSystemdTask({
        task,
        invocation,
        notify,
        executeCommand,
        userUnitDirectory: getSystemdUserUnitDirectory()
      });
    }
  } catch (error) {
    if (hasCreatedState) await rm(paths.directory, { recursive: true, force: true });
    throw new Error(`Could not create scheduled task ${id}: ${formatError(error)}`, { cause: error });
  }

  return task;
}

async function removeScheduledTask({
  executeCommand,
  schedulerRoot,
  nativeScheduler,
  id
}: RemoveScheduledTaskParams): Promise<void> {
  const paths = buildTaskPaths({ schedulerRoot, id });
  if (!existsSync(paths.metadata)) throw new Error(`Scheduled task does not exist: ${id}`);
  const task = await readScheduledTask(paths.metadata);
  if (task.scheduler !== nativeScheduler.kind) {
    throw new Error(`Scheduled task ${id} belongs to ${task.scheduler}, not ${nativeScheduler.kind}.`);
  }

  if (nativeScheduler.kind === "launchd") {
    await removeLaunchdTask({
      executeCommand,
      id,
      launchAgentsDirectory: join(homedir(), "Library", "LaunchAgents"),
      userId: nativeScheduler.userId
    });
  } else {
    await removeSystemdTask({
      executeCommand,
      id,
      userUnitDirectory: getSystemdUserUnitDirectory()
    });
  }
  await rm(paths.directory, { recursive: true, force: true });
}

type AssertSchedulerAvailableParams = {
  executeCommand: ExecuteCommand;
  nativeScheduler: NativeScheduler;
  signal?: AbortSignal;
};

async function assertSchedulerAvailable({
  executeCommand,
  nativeScheduler,
  signal
}: AssertSchedulerAvailableParams): Promise<void> {
  let result: Awaited<ReturnType<ExecuteCommand>>;
  try {
    if (nativeScheduler.kind === "launchd") {
      result = await executeCommand({
        command: "launchctl",
        args: ["print", `gui/${nativeScheduler.userId}`]
      });
    } else {
      result = await executeCommand({ command: "systemctl", args: ["--user", "show-environment"] });
    }
  } catch (error) {
    if (signal?.aborted) throw new Error("Scheduler operation was cancelled.", { cause: error });
    throw new Error(
      `opi-scheduler is unsupported because ${nativeScheduler.kind} is unavailable: ${formatError(error)}`,
      { cause: error }
    );
  }

  if (result.killed) throw new Error("Scheduler operation was cancelled.");
  if (result.code !== 0) {
    throw new Error(
      `opi-scheduler is unsupported because ${nativeScheduler.kind} is unavailable: ${formatCommandFailure(result)}`
    );
  }
}

function getNativeScheduler(platform: NodeJS.Platform): NativeScheduler {
  const kind = getSchedulerKind(platform);
  if (kind === "systemd") return { kind };
  if (!process.getuid) throw new Error("opi-scheduler cannot determine the current macOS user ID.");
  return { kind, userId: process.getuid() };
}

type RequireValueParams = {
  value?: string;
  name: string;
  action: string;
};

function requireValue({ value, name, action }: RequireValueParams): string {
  if (!value) throw new Error(`scheduler action=${action} requires ${name}.`);
  return value;
}

function requireSchedule(raw: ScheduleInput | undefined): Schedule {
  if (!raw) throw new Error("scheduler action=create requires schedule.");
  return parseSchedule(raw);
}

function getSystemdUserUnitDirectory(): string {
  const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
  if (!xdgConfigHome) return join(homedir(), ".config", "systemd", "user");
  if (!isAbsolute(xdgConfigHome) || /[\r\n\0]/u.test(xdgConfigHome)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path without control characters.");
  }
  return join(xdgConfigHome, "systemd", "user");
}

function getScheduledPath(): string {
  const path = process.env["PATH"];
  if (!path) throw new Error("Cannot schedule Pi because PATH is not set.");
  if (/[\r\n\0]/u.test(path)) throw new Error("Cannot schedule Pi because PATH contains control characters.");
  return path;
}

function formatChildModel(model: ChildModel | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

function formatScheduledTask(task: ScheduledTask): string {
  const model = task.model ?? "Pi default";
  const thinkingLevel = task.thinkingLevel ?? "Pi default";
  const skills = task.skills.length > 0 ? task.skills.join(", ") : "none";
  return `${task.id}\nSchedule: ${formatSchedule(task.schedule)}\nDirectory: ${task.workingDirectory}\nModel: ${model}\nThinking: ${thinkingLevel}\nTools: ${task.tools.join(", ")}\nSkills: ${skills}\nOutput: ${task.stdoutPath}\nErrors: ${task.stderrPath}`;
}

async function formatOutput(output: string): Promise<string> {
  const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncated.truncated) return output;

  const directory = await mkdtemp(join(tmpdir(), "opi-scheduler-"));
  const outputPath = join(directory, "output.txt");
  await writeFile(outputPath, output, "utf8");
  return `${truncated.content}\n\n[Output truncated from ${formatSize(truncated.totalBytes)}. Full output: ${outputPath}]`;
}
