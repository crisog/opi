import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildScheduledPiArgs } from "../src/index.ts";
import { renderLaunchdPlist } from "../src/launchd.ts";
import {
  createTaskState,
  formatSchedule,
  getSchedulerKind,
  listScheduledTasks,
  parseSchedule,
  type PiInvocation,
  type Schedule,
  type ScheduledTask
} from "../src/scheduler.ts";
import { getSystemdUnitPaths, installSystemdTask, renderSystemdService, renderSystemdTimer } from "../src/systemd.ts";

const TASK: ScheduledTask = {
  id: "weekday-check",
  scheduler: "launchd",
  schedule: {
    kind: "calendar",
    hour: 9,
    minute: 5,
    weekdays: [1, 5, 7]
  },
  workingDirectory: "/Users/example/Code & Notes/project",
  tools: ["read", "grep", "bash"],
  skills: ["code-review"],
  model: "openai-codex/gpt-5.6-luna",
  thinkingLevel: "high",
  createdAt: "2026-08-07T12:00:00.000Z",
  instructionsPath: "/Users/example/.pi/agent/scheduler/tasks/weekday-check/instructions.md",
  stdoutPath: "/Users/example/.pi/agent/scheduler/tasks/weekday-check/stdout.log",
  stderrPath: "/Users/example/.pi/agent/scheduler/tasks/weekday-check/stderr.log"
};

const INVOCATION: PiInvocation = {
  command: "/usr/local/bin/node",
  args: ["/usr/local/lib/pi/cli.js", "--print", `@${TASK.instructionsPath}`],
  environment: {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    PI_CODING_AGENT_DIR: "/Users/example/.pi/agent"
  }
};

test("builds an isolated scheduled Pi invocation with explicit capabilities", () => {
  const args = buildScheduledPiArgs({
    instructionsPath: TASK.instructionsPath,
    isProjectTrusted: true,
    model: TASK.model,
    skills: [{ name: "code-review", path: "/skills/code-review/SKILL.md" }],
    thinkingLevel: TASK.thinkingLevel,
    tools: TASK.tools
  });

  assert.deepEqual(args, [
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    "read,grep,bash",
    "--approve",
    "--skill",
    "/skills/code-review/SKILL.md",
    "--append-system-prompt",
    "You must use the following skills for this scheduled task:\n- code-review: /skills/code-review/SKILL.md\nRead each required SKILL.md in full before starting, follow its instructions, and resolve relative references from its containing directory.",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "high",
    `@${TASK.instructionsPath}`
  ]);
});

test("renders every selected weekday in a launchd schedule", () => {
  const plist = renderLaunchdPlist({ task: TASK, invocation: INVOCATION, notify: false });

  assert.match(
    plist,
    /<key>Weekday<\/key>\s*<integer>1<\/integer>[\s\S]*<key>Weekday<\/key>\s*<integer>5<\/integer>[\s\S]*<key>Weekday<\/key>\s*<integer>7<\/integer>/u
  );
});

test("escapes paths embedded in a launchd property list", () => {
  const plist = renderLaunchdPlist({ task: TASK, invocation: INVOCATION, notify: false });

  assert.match(plist, /<string>\/Users\/example\/Code &amp; Notes\/project<\/string>/u);
});

test("preserves PATH for scheduled launchd checks", () => {
  const plist = renderLaunchdPlist({ task: TASK, invocation: INVOCATION, notify: false });

  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/u);
});

test("preserves the Pi config directory for scheduled launchd checks", () => {
  const plist = renderLaunchdPlist({ task: TASK, invocation: INVOCATION, notify: false });

  assert.match(plist, /<key>PI_CODING_AGENT_DIR<\/key>\s*<string>\/Users\/example\/\.pi\/agent<\/string>/u);
});

test("renders every selected weekday in a systemd timer", () => {
  const timer = renderSystemdTimer({ ...TASK, scheduler: "systemd" });

  assert.match(
    timer,
    /OnCalendar=Mon \*-\*-\* 09:05:00[\s\S]*OnCalendar=Fri \*-\*-\* 09:05:00[\s\S]*OnCalendar=Sun \*-\*-\* 09:05:00/u
  );
});

test("makes systemd timers persistent across downtime", () => {
  const timer = renderSystemdTimer({ ...TASK, scheduler: "systemd" });

  assert.match(timer, /Persistent=true/u);
});

test("renders the Pi invocation in a systemd service", () => {
  const service = renderSystemdService({
    task: { ...TASK, scheduler: "systemd" },
    invocation: INVOCATION,
    notify: false
  });

  assert.match(service, /ExecStart="\/usr\/local\/bin\/node" "\/usr\/local\/lib\/pi\/cli\.js" "--print"/u);
});

test("escapes systemd working-directory paths without quoting them", () => {
  const service = renderSystemdService({
    task: { ...TASK, scheduler: "systemd", workingDirectory: "/tmp/project notes" },
    invocation: INVOCATION,
    notify: false
  });

  assert.match(service, /WorkingDirectory=\/tmp\/project\\x20notes/u);
});

test("routes systemd task output to its persistent logs", () => {
  const service = renderSystemdService({
    task: { ...TASK, scheduler: "systemd" },
    invocation: INVOCATION,
    notify: false
  });

  assert.match(service, /StandardOutput=append:.*\/stdout\.log[\s\S]*StandardError=append:.*\/stderr\.log/u);
});

test("preserves PATH for scheduled systemd checks", () => {
  const service = renderSystemdService({
    task: { ...TASK, scheduler: "systemd" },
    invocation: INVOCATION,
    notify: false
  });

  assert.match(service, /Environment="PATH=\/opt\/homebrew\/bin:\/usr\/bin:\/bin"/u);
});

test("escapes systemd command dollars without changing environment values", () => {
  const service = renderSystemdService({
    task: { ...TASK, scheduler: "systemd" },
    invocation: {
      ...INVOCATION,
      command: "/Users/$USER/bin/node",
      environment: { ...INVOCATION.environment, PATH: "/Users/$USER/bin:/usr/bin" }
    },
    notify: false
  });

  assert.match(
    service,
    /Environment="PATH=\/Users\/\$USER\/bin:\/usr\/bin"[\s\S]*ExecStart="\/Users\/\$\$USER\/bin\/node"/u
  );
});

test("preserves the Pi config directory for scheduled systemd checks", () => {
  const service = renderSystemdService({
    task: { ...TASK, scheduler: "systemd" },
    invocation: INVOCATION,
    notify: false
  });

  assert.match(service, /Environment="PI_CODING_AGENT_DIR=\/Users\/example\/\.pi\/agent"/u);
});

test("cleans systemd unit files when enabling a timer fails", async () => {
  const userUnitDirectory = await mkdtemp(join(tmpdir(), "opi-systemd-test-"));
  let commandIndex = 0;
  let errorMessage: string | undefined;
  try {
    try {
      await installSystemdTask({
        task: { ...TASK, scheduler: "systemd" },
        invocation: INVOCATION,
        notify: false,
        userUnitDirectory,
        async executeCommand() {
          commandIndex += 1;
          return {
            stdout: "",
            stderr: commandIndex === 2 ? "enable failed" : "",
            code: commandIndex === 2 ? 1 : 0,
            killed: false
          };
        }
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const paths = getSystemdUnitPaths({ userUnitDirectory, id: TASK.id });
    assert.deepEqual(
      {
        errorMessage,
        serviceExists: existsSync(paths.service),
        timerExists: existsSync(paths.timer)
      },
      {
        errorMessage: "Could not enable systemd timer weekday-check: enable failed",
        serviceExists: false,
        timerExists: false
      }
    );
  } finally {
    await rm(userUnitDirectory, { recursive: true, force: true });
  }
});

test("persists and lists a scheduled task", async () => {
  const schedulerRoot = await mkdtemp(join(tmpdir(), "opi-scheduler-test-"));
  try {
    await createTaskState({ schedulerRoot, task: TASK, instructions: "Check the project." });

    assert.deepEqual(await listScheduledTasks(schedulerRoot), [TASK]);
  } finally {
    await rm(schedulerRoot, { recursive: true, force: true });
  }
});

test("rejects operating systems without a supported native scheduler", () => {
  assert.throws(() => getSchedulerKind("win32"), /opi-scheduler is unsupported on win32/);
});

test("parses an interval schedule", () => {
  const schedule = parseSchedule({ intervalSeconds: 60 });
  assert.deepEqual(schedule, { kind: "interval", intervalSeconds: 60 });
});

test("parses a calendar schedule", () => {
  const schedule = parseSchedule({ hour: 9, minute: 5 });
  assert.deepEqual(schedule, { kind: "calendar", hour: 9, minute: 5 });
});

test("parses a calendar schedule with weekdays", () => {
  const schedule = parseSchedule({ hour: 9, minute: 5, weekdays: [1, 5] });
  assert.deepEqual(schedule, { kind: "calendar", hour: 9, minute: 5, weekdays: [1, 5] });
});

test("rejects a schedule with both interval and calendar", () => {
  assert.throws(() => parseSchedule({ intervalSeconds: 60, hour: 9, minute: 5 }), /cannot have both/);
});

test("rejects an empty schedule", () => {
  assert.throws(() => parseSchedule({}), /must have either/);
});

test("formats an interval schedule in seconds", () => {
  const schedule: Schedule = { kind: "interval", intervalSeconds: 30 };
  assert.equal(formatSchedule(schedule), "every 30s");
});

test("formats an interval schedule in minutes", () => {
  const schedule: Schedule = { kind: "interval", intervalSeconds: 300 };
  assert.equal(formatSchedule(schedule), "every 5min");
});

test("renders StartInterval in a launchd property list", () => {
  const task: ScheduledTask = {
    ...TASK,
    schedule: { kind: "interval", intervalSeconds: 60 }
  };
  const plist = renderLaunchdPlist({ task, invocation: INVOCATION, notify: false });
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/u);
  assert.doesNotMatch(plist, /StartCalendarInterval/u);
});

test("renders OnUnitActiveSec in a systemd timer with no Persistent", () => {
  const timer = renderSystemdTimer({
    ...TASK,
    scheduler: "systemd",
    schedule: { kind: "interval", intervalSeconds: 120 }
  });
  assert.match(timer, /OnUnitActiveSec=120s/u);
  assert.doesNotMatch(timer, /OnCalendar=/u);
  assert.doesNotMatch(timer, /Persistent=true/u);
});

test("wraps launchd command in notification shell when notify is enabled", () => {
  const plist = renderLaunchdPlist({ task: TASK, invocation: INVOCATION, notify: true });
  assert.match(plist, /<string>\/bin\/bash<\/string>/u);
  assert.match(plist, /<string>-c<\/string>/u);
  assert.match(plist, /osascript -e/u);
  assert.match(plist, /completed successfully/u);
});

test("wraps systemd command in notification shell when notify is enabled", () => {
  const service = renderSystemdService({
    task: { ...TASK, scheduler: "systemd" },
    invocation: INVOCATION,
    notify: true
  });
  assert.match(service, /ExecStart="\/bin\/bash" "-c"/u);
  assert.match(service, /notify-send/u);
  assert.match(service, /completed successfully/u);
});
