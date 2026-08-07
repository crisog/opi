import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecuteCommand, PiInvocation, Schedule, ScheduledTask } from "./scheduler.ts";

const SYSTEMD_UNIT_PREFIX = "opi-scheduler";
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

type RenderSystemdServiceParams = {
  task: ScheduledTask;
  invocation: PiInvocation;
};

type InstallSystemdTaskParams = RenderSystemdServiceParams & {
  executeCommand: ExecuteCommand;
  userUnitDirectory: string;
};

type RemoveSystemdTaskParams = {
  executeCommand: ExecuteCommand;
  id: string;
  userUnitDirectory: string;
};

type SystemdUnitPaths = {
  service: string;
  timer: string;
};

function getSystemdUnitName(id: string): string {
  return `${SYSTEMD_UNIT_PREFIX}-${id}`;
}

export function getSystemdUnitPaths({
  userUnitDirectory,
  id
}: Omit<RemoveSystemdTaskParams, "executeCommand">): SystemdUnitPaths {
  const unitName = getSystemdUnitName(id);
  return {
    service: join(userUnitDirectory, `${unitName}.service`),
    timer: join(userUnitDirectory, `${unitName}.timer`)
  };
}

export function renderSystemdService({ task, invocation }: RenderSystemdServiceParams): string {
  const command = [invocation.command, ...invocation.args].map(quoteSystemdArgument).join(" ");
  return `[Unit]
Description=Run scheduled Pi task ${escapeUnitText(task.id)}

[Service]
Type=oneshot
WorkingDirectory=${quoteSystemdValue(task.workingDirectory)}
Environment=${quoteSystemdValue(`PATH=${invocation.environment.PATH}`)}
Environment=${quoteSystemdValue(`PI_CODING_AGENT_DIR=${invocation.environment.PI_CODING_AGENT_DIR}`)}
ExecStart=${command}
StandardOutput=${quoteSystemdValue(`append:${task.stdoutPath}`)}
StandardError=${quoteSystemdValue(`append:${task.stderrPath}`)}
`;
}

export function renderSystemdTimer(task: ScheduledTask): string {
  const unitName = getSystemdUnitName(task.id);
  const calendarLines = buildOnCalendarValues(task.schedule)
    .map((value) => `OnCalendar=${value}`)
    .join("\n");
  return `[Unit]
Description=Schedule Pi task ${escapeUnitText(task.id)}

[Timer]
${calendarLines}
Persistent=true
Unit=${unitName}.service

[Install]
WantedBy=timers.target
`;
}

export async function installSystemdTask({
  task,
  invocation,
  executeCommand,
  userUnitDirectory
}: InstallSystemdTaskParams): Promise<SystemdUnitPaths> {
  await mkdir(userUnitDirectory, { recursive: true });
  const paths = getSystemdUnitPaths({ userUnitDirectory, id: task.id });
  if (existsSync(paths.service) || existsSync(paths.timer)) {
    throw new Error(`systemd task already exists: ${task.id}`);
  }
  await writeFile(paths.service, renderSystemdService({ task, invocation }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  try {
    await writeFile(paths.timer, renderSystemdTimer(task), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(paths.service, { force: true });
    throw error;
  }

  const reload = await executeCommand({ command: "systemctl", args: ["--user", "daemon-reload"] });
  if (reload.code !== 0 || reload.killed) {
    await removeUnitFiles(paths);
    throw new Error(`Could not reload systemd user units: ${commandFailure(reload)}`);
  }

  const timerUnit = `${getSystemdUnitName(task.id)}.timer`;
  const enable = await executeCommand({ command: "systemctl", args: ["--user", "enable", "--now", timerUnit] });
  if (enable.code === 0 && !enable.killed) return paths;

  const disable = await executeCommand({
    command: "systemctl",
    args: ["--user", "disable", "--now", timerUnit]
  });
  await removeUnitFiles(paths);
  const cleanupReload = await executeCommand({ command: "systemctl", args: ["--user", "daemon-reload"] });
  const cleanupFailures: string[] = [];
  if (disable.code !== 0 || disable.killed) cleanupFailures.push(`disable failed: ${commandFailure(disable)}`);
  if (cleanupReload.code !== 0 || cleanupReload.killed) {
    cleanupFailures.push(`reload failed: ${commandFailure(cleanupReload)}`);
  }
  const cleanupMessage = cleanupFailures.length > 0 ? `; cleanup ${cleanupFailures.join("; ")}` : "";
  throw new Error(`Could not enable systemd timer ${task.id}: ${commandFailure(enable)}${cleanupMessage}`);
}

export async function removeSystemdTask({
  executeCommand,
  id,
  userUnitDirectory
}: RemoveSystemdTaskParams): Promise<void> {
  const timerUnit = `${getSystemdUnitName(id)}.timer`;
  const disable = await executeCommand({
    command: "systemctl",
    args: ["--user", "disable", "--now", timerUnit]
  });
  if (disable.code !== 0 || disable.killed) {
    throw new Error(`Could not disable systemd timer ${id}: ${commandFailure(disable)}`);
  }

  await removeUnitFiles(getSystemdUnitPaths({ userUnitDirectory, id }));
  const reload = await executeCommand({ command: "systemctl", args: ["--user", "daemon-reload"] });
  if (reload.code !== 0 || reload.killed) {
    throw new Error(`Removed ${id}, but could not reload systemd user units: ${commandFailure(reload)}`);
  }
}

function buildOnCalendarValues(schedule: Schedule): string[] {
  const time = `${schedule.hour.toString().padStart(2, "0")}:${schedule.minute.toString().padStart(2, "0")}:00`;
  if (!schedule.weekdays) return [`*-*-* ${time}`];

  const values: string[] = [];
  for (const weekday of schedule.weekdays) {
    const weekdayName = WEEKDAY_NAMES[weekday - 1];
    if (!weekdayName) throw new Error(`Invalid weekday: ${weekday}`);
    values.push(`${weekdayName} *-*-* ${time}`);
  }
  return values;
}

async function removeUnitFiles(paths: SystemdUnitPaths): Promise<void> {
  await Promise.all([rm(paths.service, { force: true }), rm(paths.timer, { force: true })]);
}

function quoteSystemdArgument(value: string): string {
  return quoteSystemd({ value, shouldEscapeDollar: true });
}

function quoteSystemdValue(value: string): string {
  return quoteSystemd({ value, shouldEscapeDollar: false });
}

type QuoteSystemdParams = {
  value: string;
  shouldEscapeDollar: boolean;
};

function quoteSystemd({ value, shouldEscapeDollar }: QuoteSystemdParams): string {
  assertSingleLine(value);
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (shouldEscapeDollar) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

function escapeUnitText(value: string): string {
  assertSingleLine(value);
  return value.replaceAll("%", "%%");
}

function assertSingleLine(value: string): void {
  if (/[\r\n\0]/u.test(value)) throw new Error("systemd values must not contain control characters.");
}

function commandFailure(result: { stderr: string; killed: boolean; code: number }): string {
  if (result.killed) return "command was cancelled";
  return result.stderr.trim() || `command exited with code ${result.code}`;
}
