import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatCommandFailure,
  type CalendarSchedule,
  type ExecuteCommand,
  type IntervalSchedule,
  type PiInvocation,
  type ScheduledTask
} from "./scheduler.ts";

const LAUNCHD_LABEL_PREFIX = "com.opi.scheduler";

type RenderLaunchdPlistParams = {
  task: ScheduledTask;
  invocation: PiInvocation;
  lastRunPath: string | undefined;
};

type InstallLaunchdTaskParams = RenderLaunchdPlistParams & {
  executeCommand: ExecuteCommand;
  launchAgentsDirectory: string;
  userId: number;
};

type RemoveLaunchdTaskParams = {
  executeCommand: ExecuteCommand;
  id: string;
  launchAgentsDirectory: string;
  userId: number;
};

function getLaunchdLabel(id: string): string {
  return `${LAUNCHD_LABEL_PREFIX}.${id}`;
}

function getLaunchdPlistPath({
  launchAgentsDirectory,
  id
}: Omit<RemoveLaunchdTaskParams, "executeCommand" | "userId">): string {
  return join(launchAgentsDirectory, `${getLaunchdLabel(id)}.plist`);
}

export function renderLaunchdPlist({ task, invocation, lastRunPath }: RenderLaunchdPlistParams): string {
  const label = getLaunchdLabel(task.id);
  let schedule: string;
  if (task.schedule.kind === "interval") {
    schedule = renderStartInterval(task.schedule);
  } else {
    schedule = renderCalendarInterval(task.schedule);
  }

  let programArguments: string;
  if (lastRunPath !== undefined) {
    programArguments = renderNotifyWrapper({ invocation, lastRunPath });
  } else {
    programArguments = [invocation.command, ...invocation.args]
      .map((argument) => `      <string>${escapeXml(argument)}</string>`)
      .join("\n");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(task.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(invocation.environment.PATH)}</string>
    <key>PI_CODING_AGENT_DIR</key>
    <string>${escapeXml(invocation.environment.PI_CODING_AGENT_DIR)}</string>
  </dict>
  ${schedule}
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(task.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(task.stderrPath)}</string>
</dict>
</plist>
`;
}

export async function installLaunchdTask({
  task,
  invocation,
  lastRunPath,
  executeCommand,
  launchAgentsDirectory,
  userId
}: InstallLaunchdTaskParams): Promise<string> {
  await mkdir(launchAgentsDirectory, { recursive: true });
  const plistPath = getLaunchdPlistPath({ launchAgentsDirectory, id: task.id });
  if (existsSync(plistPath)) throw new Error(`launchd task already exists: ${task.id}`);
  await writeFile(plistPath, renderLaunchdPlist({ task, invocation, lastRunPath }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });

  const result = await executeCommand({
    command: "launchctl",
    args: ["bootstrap", `gui/${userId}`, plistPath]
  });
  if (result.code === 0 && !result.killed) return plistPath;

  await rm(plistPath, { force: true });
  throw new Error(`Could not install launchd task ${task.id}: ${formatCommandFailure(result)}`);
}

export async function removeLaunchdTask({
  executeCommand,
  id,
  launchAgentsDirectory,
  userId
}: RemoveLaunchdTaskParams): Promise<void> {
  const label = getLaunchdLabel(id);
  const domainTarget = `gui/${userId}/${label}`;
  const status = await executeCommand({ command: "launchctl", args: ["print", domainTarget] });
  if (status.killed) throw new Error(`Could not inspect launchd task ${id}: command was cancelled`);
  if (status.code === 0) {
    const result = await executeCommand({ command: "launchctl", args: ["bootout", domainTarget] });
    if (result.code !== 0 || result.killed) {
      throw new Error(`Could not unload launchd task ${id}: ${formatCommandFailure(result)}`);
    }
  } else if (!isMissingService(status)) {
    throw new Error(`Could not inspect launchd task ${id}: ${formatCommandFailure(status)}`);
  }

  await rm(getLaunchdPlistPath({ launchAgentsDirectory, id }), { force: true });
}

function renderCalendarInterval(schedule: CalendarSchedule): string {
  if (!schedule.weekdays) {
    return `  <dict>\n${renderCalendarFields(schedule)}\n  </dict>`;
  }

  const entries = schedule.weekdays
    .map(
      (weekday) =>
        `    <dict>\n      <key>Weekday</key>\n      <integer>${weekday}</integer>\n${renderCalendarFields(schedule, "      ")}\n    </dict>`
    )
    .join("\n");
  return `  <array>\n${entries}\n  </array>`;
}

function renderCalendarFields(schedule: CalendarSchedule, indentation = "    "): string {
  return `${indentation}<key>Hour</key>\n${indentation}<integer>${schedule.hour}</integer>\n${indentation}<key>Minute</key>\n${indentation}<integer>${schedule.minute}</integer>`;
}

function renderStartInterval(schedule: IntervalSchedule): string {
  return `<key>StartInterval</key>\n  <integer>${schedule.intervalSeconds}</integer>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isMissingService(result: { stdout: string; stderr: string }): boolean {
  return /could not find service|service not found/u.test(`${result.stdout}\n${result.stderr}`.toLowerCase());
}

type RenderNotifyWrapperParams = {
  invocation: PiInvocation;
  lastRunPath: string;
};

function renderNotifyWrapper({ invocation, lastRunPath }: RenderNotifyWrapperParams): string {
  const piCommand = buildShellSafeCommand(invocation.command, invocation.args);
  const shellCommand = `${piCommand}; code=$?; echo '{"exitCode":'$code',"timestamp":"'$(date -Iseconds)'"}' > '${lastRunPath}'; exit $code`;
  return `      <string>/bin/bash</string>
      <string>-c</string>
      <string>${escapeXml(shellCommand)}</string>`;
}

function buildShellSafeCommand(command: string, args: string[]): string {
  const quoted = [command, ...args].map(quoteShellArg).join(" ");
  return quoted;
}

function quoteShellArg(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}
