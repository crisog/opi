import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecuteCommand, PiInvocation, ScheduledTask } from "./scheduler.ts";

const LAUNCHD_LABEL_PREFIX = "com.opi.scheduler";

type RenderLaunchdPlistParams = {
  task: ScheduledTask;
  invocation: PiInvocation;
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

export function renderLaunchdPlist({ task, invocation }: RenderLaunchdPlistParams): string {
  const label = getLaunchdLabel(task.id);
  const programArguments = [invocation.command, ...invocation.args]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const calendar = renderCalendarInterval(task);

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
  <key>StartCalendarInterval</key>
${calendar}
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
  executeCommand,
  launchAgentsDirectory,
  userId
}: InstallLaunchdTaskParams): Promise<string> {
  await mkdir(launchAgentsDirectory, { recursive: true });
  const plistPath = getLaunchdPlistPath({ launchAgentsDirectory, id: task.id });
  if (existsSync(plistPath)) throw new Error(`launchd task already exists: ${task.id}`);
  await writeFile(plistPath, renderLaunchdPlist({ task, invocation }), {
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
  throw new Error(`Could not install launchd task ${task.id}: ${commandFailure(result)}`);
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
      throw new Error(`Could not unload launchd task ${id}: ${commandFailure(result)}`);
    }
  } else if (!isMissingService(status)) {
    throw new Error(`Could not inspect launchd task ${id}: ${commandFailure(status)}`);
  }

  await rm(getLaunchdPlistPath({ launchAgentsDirectory, id }), { force: true });
}

function renderCalendarInterval(task: ScheduledTask): string {
  const weekdays = task.schedule.weekdays;
  if (!weekdays) return `  <dict>\n${renderCalendarFields({ task })}\n  </dict>`;

  const entries = weekdays
    .map(
      (weekday) =>
        `    <dict>\n      <key>Weekday</key>\n      <integer>${weekday}</integer>\n${renderCalendarFields({ task, indentation: "      " })}\n    </dict>`
    )
    .join("\n");
  return `  <array>\n${entries}\n  </array>`;
}

type RenderCalendarFieldsParams = {
  task: ScheduledTask;
  indentation?: string;
};

function renderCalendarFields({ task, indentation = "    " }: RenderCalendarFieldsParams): string {
  return `${indentation}<key>Hour</key>\n${indentation}<integer>${task.schedule.hour}</integer>\n${indentation}<key>Minute</key>\n${indentation}<integer>${task.schedule.minute}</integer>`;
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

function commandFailure(result: { stderr: string; killed: boolean; code: number }): string {
  if (result.killed) return "command was cancelled";
  return result.stderr.trim() || `command exited with code ${result.code}`;
}
