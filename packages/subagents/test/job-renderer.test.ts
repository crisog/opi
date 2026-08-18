import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderJobCall, renderJobResult } from "../src/job-renderer.ts";
import type { JobToolDetails } from "../src/job-output.ts";

const THEME = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  }
} as unknown as Theme;

test("renders compact job calls without dumping the full task", () => {
  const component = renderJobCall({
    args: {
      action: "start",
      task: "Inspect the authentication boundary and every implementation detail that follows it."
    },
    theme: THEME
  });

  const text = component.render(120).join("\n");
  assert.match(text, /subagent job start/u);
  assert.match(text, /Inspect the authentication boundary/u);
  assert.doesNotMatch(text, /implementation detail that follows it/u);
});

test("renders partial wait and terminal states with textual labels", () => {
  const running: JobToolDetails = {
    kind: "job",
    action: "wait",
    job: {
      id: "12345678-abcd-efab-cdef-1234567890ab",
      status: "running",
      taskSummary: "Inspect auth.",
      createdAt: "2026-08-18T12:00:00.000Z",
      updatedAt: "2026-08-18T12:00:01.000Z"
    }
  };
  const completed: JobToolDetails = {
    kind: "job",
    action: "wait",
    job: {
      ...running.job,
      status: "completed",
      resultPath: "/private/jobs/result.md"
    }
  };

  assert.match(
    renderJobResult({ details: running, isPartial: true, expanded: false, theme: THEME }).render(120).join("\n"),
    /WAIT 12345678 — running/u
  );
  assert.match(
    renderJobResult({ details: completed, isPartial: false, expanded: false, theme: THEME }).render(120).join("\n"),
    /WAIT 12345678 — completed/u
  );

  const cancelled: JobToolDetails = {
    kind: "job",
    action: "cancel",
    job: {
      ...running.job,
      status: "cancelled"
    }
  };
  assert.match(
    renderJobResult({ details: cancelled, isPartial: false, expanded: false, theme: THEME }).render(120).join("\n"),
    /CANCEL 12345678 — cancelled/u
  );
});

test("renders compact and expanded job lists", () => {
  const details: JobToolDetails = {
    kind: "list",
    action: "list",
    jobs: [
      {
        id: "12345678-abcd-efab-cdef-1234567890ab",
        status: "failed",
        taskSummary: "Inspect auth.",
        createdAt: "2026-08-18T12:00:00.000Z",
        updatedAt: "2026-08-18T12:00:01.000Z",
        error: "Provider unavailable."
      }
    ]
  };

  const compact = renderJobResult({ details, isPartial: false, expanded: false, theme: THEME }).render(120).join("\n");
  assert.match(compact, /12345678 failed Inspect auth/u);
  assert.doesNotMatch(compact, /Provider unavailable/u);

  const expanded = renderJobResult({ details, isPartial: false, expanded: true, theme: THEME }).render(120).join("\n");
  assert.match(expanded, /12345678-abcd-efab-cdef-1234567890ab/u);
  assert.match(expanded, /Provider unavailable/u);
});
