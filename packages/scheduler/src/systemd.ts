import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatCommandFailure,
  type CalendarSchedule,
  type ExecuteCommand,
  type PiInvocation,
  type ScheduledTask,
  type Weekday
} from "./scheduler.ts";

const SYSTEMD_UNIT_PREFIX = "opi-scheduler";
const WEEKDAY_NAMES: Record<Weekday, string> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun"
};

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
WorkingDirectory=${escapeSystemdSetting(task.workingDirectory)}
Environment=${quoteSystemdEnvironment(`PATH=${invocation.environment.PATH}`)}
Environment=${quoteSystemdEnvironment(`PI_CODING_AGENT_DIR=${invocation.environment.PI_CODING_AGENT_DIR}`)}
ExecStart=${command}
`;
}

export function renderSystemdTimer(task: ScheduledTask): string {
  const unitName = getSystemdUnitName(task.nativeId ?? task.id);
  let timerLines: string;
  let persistent: string;
  if (task.schedule.kind === "interval") {
    timerLines = `OnUnitActiveSec=${task.schedule.intervalSeconds}s`;
    persistent = "";
  } else {
    timerLines = buildOnCalendarValues(task.schedule)
      .map((value) => `OnCalendar=${value}`)
      .join("\n");
    persistent = "Persistent=true\n";
  }
  return `[Unit]
Description=Schedule Pi task ${escapeUnitText(task.id)}

[Timer]
${timerLines}
${persistent}Unit=${unitName}.service

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
  const nativeId = task.nativeId ?? task.id;
  const paths = getSystemdUnitPaths({ userUnitDirectory, id: nativeId });
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
    throw new Error(`Could not reload systemd user units: ${formatCommandFailure(reload)}`);
  }

  const timerUnit = `${getSystemdUnitName(nativeId)}.timer`;
  const enable = await executeCommand({ command: "systemctl", args: ["--user", "enable", "--now", timerUnit] });
  if (enable.code === 0 && !enable.killed) return paths;

  const disable = await executeCommand({
    command: "systemctl",
    args: ["--user", "disable", "--now", timerUnit]
  });
  await removeUnitFiles(paths);
  const cleanupReload = await executeCommand({ command: "systemctl", args: ["--user", "daemon-reload"] });
  const cleanupFailures: string[] = [];
  if (disable.code !== 0 || disable.killed) cleanupFailures.push(`disable failed: ${formatCommandFailure(disable)}`);
  if (cleanupReload.code !== 0 || cleanupReload.killed) {
    cleanupFailures.push(`reload failed: ${formatCommandFailure(cleanupReload)}`);
  }
  const cleanupMessage = cleanupFailures.length > 0 ? `; cleanup ${cleanupFailures.join("; ")}` : "";
  throw new Error(`Could not enable systemd timer ${task.id}: ${formatCommandFailure(enable)}${cleanupMessage}`);
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
    throw new Error(`Could not disable systemd timer ${id}: ${formatCommandFailure(disable)}`);
  }

  await removeUnitFiles(getSystemdUnitPaths({ userUnitDirectory, id }));
  const reload = await executeCommand({ command: "systemctl", args: ["--user", "daemon-reload"] });
  if (reload.code !== 0 || reload.killed) {
    throw new Error(`Removed ${id}, but could not reload systemd user units: ${formatCommandFailure(reload)}`);
  }
}

function buildOnCalendarValues(schedule: CalendarSchedule): string[] {
  const time = `${schedule.hour.toString().padStart(2, "0")}:${schedule.minute.toString().padStart(2, "0")}:00`;
  if (!schedule.weekdays) return [`*-*-* ${time}`];

  const values: string[] = [];
  for (const weekday of schedule.weekdays) {
    const name = WEEKDAY_NAMES[weekday];
    if (name) {
      values.push(`${name} *-*-* ${time}`);
    }
  }
  return values;
}

async function removeUnitFiles(paths: SystemdUnitPaths): Promise<void> {
  await Promise.all([rm(paths.service, { force: true }), rm(paths.timer, { force: true })]);
}

function quoteSystemdArgument(value: string): string {
  return quoteSystemd({ value, shouldEscapeDollar: true });
}

function quoteSystemdEnvironment(value: string): string {
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

function escapeSystemdSetting(value: string): string {
  assertSingleLine(value);
  let escaped = "";
  for (const character of value) {
    if (character === "%") {
      escaped += "%%";
    } else if (character === "\\") {
      escaped += "\\\\";
    } else if (character.charCodeAt(0) <= 0x20 || /["'#;]/u.test(character)) {
      escaped += `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function escapeUnitText(value: string): string {
  assertSingleLine(value);
  return value.replaceAll("%", "%%");
}

function assertSingleLine(value: string): void {
  if (/[\r\n\0]/u.test(value)) throw new Error("systemd values must not contain control characters.");
}
