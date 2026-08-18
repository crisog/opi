import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSchedulerList, formatSchedulerTaskResult } from "../src/scheduler-output.ts";
import type { LatestSchedulerRun, StoredSchedulerTask } from "../src/scheduler-store.ts";

function createTask(rootPath: string): StoredSchedulerTask {
  return {
    version: 1,
    id: "daily-check",
    nativeId: "workspace-daily-check",
    scheduler: "launchd",
    schedule: { kind: "calendar", hour: 9, minute: 0 },
    workspacePath: "/workspace",
    workingDirectory: "/workspace",
    workspaceKey: "workspace",
    directoryPath: rootPath,
    instructionsPath: join(rootPath, "instructions.md"),
    instructionsSummary: "Inspect the workspace.",
    latestRunPath: join(rootPath, "latest-run.json"),
    resultPath: join(rootPath, "result.md"),
    stdoutPath: join(rootPath, "stdout.log"),
    stderrPath: join(rootPath, "stderr.log"),
    tools: ["read"],
    skills: [],
    childCommand: "pi",
    childArgs: [],
    environment: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/agent" },
    createdAt: "2026-08-18T12:00:00.000Z"
  };
}

test("formats a concise workspace task list with latest status", () => {
  const task = createTask("/private/task");
  const result = formatSchedulerList([{ task, run: null }]);

  assert.equal(result.details.kind, "list");
  assert.match(result.content[0].text, /daily-check never_run 2026-08-18T12:00:00\.000Z daily at 09:00/u);
  assert.doesNotMatch(result.content[0].text, /stdout\.log/u);
});

test("returns a bounded completed result and its stable full path", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-scheduler-output-test-"));
  try {
    const task = createTask(rootPath);
    const output = `${"result line\n".repeat(5_000)}tail`;
    await writeFile(task.resultPath, output, "utf8");
    const run: LatestSchedulerRun = {
      version: 1,
      taskId: task.id,
      kind: "completed",
      startedAt: "2026-08-18T12:01:00.000Z",
      finishedAt: "2026-08-18T12:02:00.000Z",
      resultPath: task.resultPath
    };

    const result = await formatSchedulerTaskResult({ action: "status", task, run });

    assert.match(result.content[0].text, /Output truncated/u);
    assert.match(result.content[0].text, new RegExp(task.resultPath.replaceAll("/", "\\/"), "u"));
    assert.ok(result.content[0].text.length < output.length);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("surfaces a failed run as task status", async () => {
  const task = createTask("/private/task");
  const run: LatestSchedulerRun = {
    version: 1,
    taskId: task.id,
    kind: "failed",
    startedAt: "2026-08-18T12:01:00.000Z",
    finishedAt: "2026-08-18T12:02:00.000Z",
    error: "Provider unavailable."
  };

  const result = await formatSchedulerTaskResult({ action: "status", task, run });

  assert.match(result.content[0].text, /daily-check: failed/u);
  assert.match(result.content[0].text, /Provider unavailable/u);
});
