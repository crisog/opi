import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderSchedulerCall, renderSchedulerResult } from "../src/scheduler-renderer.ts";
import type { SchedulerToolDetails } from "../src/scheduler-output.ts";

const THEME = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  }
} as unknown as Theme;

test("renders compact create calls without dumping full instructions", () => {
  const component = renderSchedulerCall({
    args: {
      action: "create",
      id: "daily-check",
      instructions: "Inspect the authentication boundary and every implementation detail that follows it.",
      schedule: { hour: 9, minute: 0 }
    },
    theme: THEME
  });

  const text = component.render(120).join("\n");
  assert.match(text, /scheduler create daily-check/u);
  assert.match(text, /Inspect the authentication boundary/u);
  assert.match(text, /daily at 09:00/u);
  assert.doesNotMatch(text, /implementation detail that follows it/u);
});

test("renders textual running and completed states", () => {
  const running: SchedulerToolDetails = {
    kind: "task",
    action: "status",
    task: {
      id: "daily-check",
      schedule: "daily at 09:00",
      status: "running",
      instructionsSummary: "Inspect the workspace.",
      workingDirectory: "/workspace",
      createdAt: "2026-08-18T12:00:00.000Z",
      tools: ["read"],
      skills: [],
      startedAt: "2026-08-18T12:01:00.000Z",
      stdoutPath: "/private/stdout.log",
      stderrPath: "/private/stderr.log"
    }
  };
  const completed: SchedulerToolDetails = {
    ...running,
    task: {
      ...running.task,
      status: "completed",
      resultPath: "/private/result.md",
      result: "Scheduled result."
    }
  };

  assert.match(
    renderSchedulerResult({ details: running, isPartial: true, expanded: false, theme: THEME }).render(120).join("\n"),
    /STATUS daily-check — running/u
  );
  assert.match(
    renderSchedulerResult({ details: completed, isPartial: false, expanded: false, theme: THEME })
      .render(120)
      .join("\n"),
    /STATUS daily-check — completed/u
  );
  assert.match(
    renderSchedulerResult({ details: completed, isPartial: false, expanded: true, theme: THEME })
      .render(120)
      .join("\n"),
    /Scheduled result\./u
  );
});

test("renders partial creation and terminal mutation success textually", () => {
  const progress: SchedulerToolDetails = {
    kind: "progress",
    action: "create",
    id: "daily-check"
  };
  const created: SchedulerToolDetails = {
    kind: "task",
    action: "create",
    task: {
      id: "daily-check",
      schedule: "daily at 09:00",
      status: "never_run",
      instructionsSummary: "Inspect the workspace.",
      workingDirectory: "/workspace",
      createdAt: "2026-08-18T12:00:00.000Z",
      tools: ["read"],
      skills: [],
      stdoutPath: "/private/stdout.log",
      stderrPath: "/private/stderr.log"
    }
  };
  const removed: SchedulerToolDetails = { kind: "remove", action: "remove", id: "daily-check" };

  assert.match(
    renderSchedulerResult({ details: progress, isPartial: true, expanded: false, theme: THEME }).render(120).join("\n"),
    /CREATE daily-check — creating/u
  );
  assert.match(
    renderSchedulerResult({ details: created, isPartial: false, expanded: false, theme: THEME }).render(120).join("\n"),
    /CREATE daily-check — created · never_run/u
  );
  assert.match(
    renderSchedulerResult({ details: removed, isPartial: false, expanded: false, theme: THEME }).render(120).join("\n"),
    /REMOVE daily-check — removed/u
  );
});

test("renders compact and expanded task lists", () => {
  const taskDetails: Extract<SchedulerToolDetails, { kind: "task" }> = {
    kind: "task",
    action: "status",
    task: {
      id: "daily-check",
      schedule: "daily at 09:00",
      status: "failed",
      instructionsSummary: "Inspect the workspace.",
      workingDirectory: "/workspace",
      createdAt: "2026-08-18T12:00:00.000Z",
      tools: ["read"],
      skills: [],
      startedAt: "2026-08-18T12:01:00.000Z",
      finishedAt: "2026-08-18T12:02:00.000Z",
      stdoutPath: "/private/stdout.log",
      stderrPath: "/private/stderr.log",
      error: "Provider unavailable."
    }
  };
  const details: SchedulerToolDetails = { kind: "list", action: "list", tasks: [taskDetails.task] };

  const compact = renderSchedulerResult({ details, isPartial: false, expanded: false, theme: THEME })
    .render(120)
    .join("\n");
  assert.match(compact, /daily-check failed 2026-08-18T12:02:00\.000Z daily at 09:00/u);
  assert.doesNotMatch(compact, /Provider unavailable/u);

  const expanded = renderSchedulerResult({ details, isPartial: false, expanded: true, theme: THEME })
    .render(120)
    .join("\n");
  assert.match(expanded, /Provider unavailable/u);
});
