import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSchedulerStore } from "../src/scheduler-store.ts";
import { runScheduledTask } from "../src/scheduler-runner.ts";

const RUN_STATE_POLL_ATTEMPTS = 100;
const RUN_STATE_POLL_INTERVAL_MS = 5;

type WaitForRunningParams = {
  store: Awaited<ReturnType<typeof createSchedulerStore>>;
  id: string;
};

async function waitForRunning({ store, id }: WaitForRunningParams): Promise<void> {
  for (let attempt = 0; attempt < RUN_STATE_POLL_ATTEMPTS; attempt += 1) {
    const run = await store.readLatestRun({ id });
    if (run?.kind === "running") return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, RUN_STATE_POLL_INTERVAL_MS);
    });
  }
  assert.fail("Timed out waiting for the scheduled run to start.");
}

test("stores tasks privately within their canonical workspace", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-scheduler-store-test-"));
  const agentDirectory = join(rootPath, "agent");
  const firstWorkspace = join(rootPath, "first");
  const secondWorkspace = join(rootPath, "second");
  await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);

  try {
    const firstStore = await createSchedulerStore({ agentDirectory, workspacePath: firstWorkspace });
    const secondStore = await createSchedulerStore({ agentDirectory, workspacePath: secondWorkspace });
    const first = await firstStore.createTask({
      id: "daily-check",
      scheduler: "launchd",
      schedule: { kind: "calendar", hour: 9, minute: 0 },
      instructions: "Inspect the first workspace.",
      tools: ["read"],
      skills: [],
      childCommand: process.execPath,
      childArgs: ["child.mjs"],
      environment: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });
    const second = await secondStore.createTask({
      id: "daily-check",
      scheduler: "launchd",
      schedule: { kind: "calendar", hour: 9, minute: 0 },
      instructions: "Inspect the second workspace.",
      tools: ["read"],
      skills: [],
      childCommand: process.execPath,
      childArgs: ["child.mjs"],
      environment: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });
    await secondStore.createTask({
      id: "second-only",
      scheduler: "launchd",
      schedule: { kind: "calendar", hour: 10, minute: 0 },
      instructions: "Inspect only the second workspace.",
      tools: ["read"],
      skills: [],
      childCommand: process.execPath,
      childArgs: ["child.mjs"],
      environment: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });

    assert.notEqual(first.nativeId, second.nativeId);
    assert.notEqual(first.directoryPath, second.directoryPath);
    assert.equal((await stat(first.directoryPath)).mode & 0o077, 0);
    assert.equal((await stat(first.instructionsPath)).mode & 0o077, 0);
    assert.deepEqual(await firstStore.listTasks(), [first]);
    assert.deepEqual(
      (await secondStore.listTasks()).map((task) => task.id),
      [second.id, "second-only"]
    );
    await assert.rejects(firstStore.readTask({ id: "second-only" }), /does not exist/u);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("runner publishes a completed result that a fresh store can read", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-scheduler-runner-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "child.mjs");
  await mkdir(workspacePath);
  await writeFile(
    childPath,
    `setTimeout(() => process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Scheduled result."}],stopReason:"stop"}}) + "\\n"), 50);\n`,
    "utf8"
  );

  try {
    const store = await createSchedulerStore({ agentDirectory, workspacePath });
    const task = await store.createTask({
      id: "daily-check",
      scheduler: "launchd",
      schedule: { kind: "interval", intervalSeconds: 60 },
      instructions: "Inspect the workspace.",
      tools: ["read"],
      skills: [],
      childCommand: process.execPath,
      childArgs: [childPath],
      environment: { PATH: process.env["PATH"] ?? "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });

    const runPromise = runScheduledTask({ store, id: task.id });
    await waitForRunning({ store, id: task.id });
    await runPromise;

    const freshStore = await createSchedulerStore({ agentDirectory, workspacePath });
    const run = await freshStore.readLatestRun({ id: task.id });
    assert.equal(run?.kind, "completed");
    if (run?.kind !== "completed") assert.fail("Expected a completed run.");
    assert.equal(await readFile(run.resultPath, "utf8"), "Scheduled result.");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("runner records child failures with useful diagnostics", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-scheduler-runner-failure-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "child.mjs");
  await mkdir(workspacePath);
  await writeFile(childPath, `process.stderr.write("Provider unavailable.\\n"); process.exitCode = 1;\n`, "utf8");

  try {
    const store = await createSchedulerStore({ agentDirectory, workspacePath });
    await store.createTask({
      id: "daily-check",
      scheduler: "launchd",
      schedule: { kind: "interval", intervalSeconds: 60 },
      instructions: "Inspect the workspace.",
      tools: ["read"],
      skills: [],
      childCommand: process.execPath,
      childArgs: [childPath],
      environment: { PATH: process.env["PATH"] ?? "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });

    await runScheduledTask({ store, id: "daily-check" });

    const run = await store.readLatestRun({ id: "daily-check" });
    assert.equal(run?.kind, "failed");
    if (run?.kind !== "failed") assert.fail("Expected a failed run.");
    assert.equal(run.error, "Provider unavailable.");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("runner records launch failures", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-scheduler-runner-launch-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  await mkdir(workspacePath);

  try {
    const store = await createSchedulerStore({ agentDirectory, workspacePath });
    await store.createTask({
      id: "daily-check",
      scheduler: "launchd",
      schedule: { kind: "interval", intervalSeconds: 60 },
      instructions: "Inspect the workspace.",
      tools: ["read"],
      skills: [],
      childCommand: join(rootPath, "missing-pi"),
      childArgs: [],
      environment: { PATH: process.env["PATH"] ?? "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });

    await runScheduledTask({ store, id: "daily-check" });

    const run = await store.readLatestRun({ id: "daily-check" });
    assert.equal(run?.kind, "failed");
    if (run?.kind !== "failed") assert.fail("Expected a failed run.");
    assert.match(run.error, /Scheduled child failed to launch/u);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("runner records a missing final response as a failure", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-scheduler-runner-response-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "child.mjs");
  await mkdir(workspacePath);
  await writeFile(childPath, `process.stdout.write('{"type":"agent_start"}\\n');\n`, "utf8");

  try {
    const store = await createSchedulerStore({ agentDirectory, workspacePath });
    await store.createTask({
      id: "daily-check",
      scheduler: "launchd",
      schedule: { kind: "interval", intervalSeconds: 60 },
      instructions: "Inspect the workspace.",
      tools: ["read"],
      skills: [],
      childCommand: process.execPath,
      childArgs: [childPath],
      environment: { PATH: process.env["PATH"] ?? "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });

    await runScheduledTask({ store, id: "daily-check" });

    const run = await store.readLatestRun({ id: "daily-check" });
    assert.equal(run?.kind, "failed");
    if (run?.kind !== "failed") assert.fail("Expected a failed run.");
    assert.equal(run.error, "Scheduled child returned no final response.");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("runner records malformed child output as a failure", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-scheduler-runner-malformed-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "child.mjs");
  await mkdir(workspacePath);
  await writeFile(childPath, `process.stdout.write("not json\\n");\n`, "utf8");

  try {
    const store = await createSchedulerStore({ agentDirectory, workspacePath });
    await store.createTask({
      id: "daily-check",
      scheduler: "launchd",
      schedule: { kind: "interval", intervalSeconds: 60 },
      instructions: "Inspect the workspace.",
      tools: ["read"],
      skills: [],
      childCommand: process.execPath,
      childArgs: [childPath],
      environment: { PATH: process.env["PATH"] ?? "/usr/bin", PI_CODING_AGENT_DIR: agentDirectory }
    });

    await runScheduledTask({ store, id: "daily-check" });

    const run = await store.readLatestRun({ id: "daily-check" });
    assert.equal(run?.kind, "failed");
    if (run?.kind !== "failed") assert.fail("Expected a failed run.");
    assert.equal(run.error, "Scheduled child returned no final response.");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
