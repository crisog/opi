import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJobStore } from "../src/job-store.ts";
import { formatJobResult, formatJobList } from "../src/job-output.ts";
import { startSubagentJob, waitForSubagentJob } from "../src/job-service.ts";
import { runJobWorker } from "../src/job-worker.ts";

test("creates private jobs isolated to their canonical workspace", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-store-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const otherWorkspacePath = join(rootPath, "other-workspace");
  await Promise.all([mkdir(workspacePath), mkdir(otherWorkspacePath)]);

  try {
    const store = await createJobStore({ agentDirectory, workspacePath });
    const job = await store.createQueuedJob({
      task: "Inspect the authentication boundary.",
      childCommand: "pi",
      childArgs: ["--print"]
    });

    assert.equal(job.kind, "queued");
    assert.match(job.id, /^[0-9a-f-]+$/u);
    assert.equal(job.workspacePath, await realpath(workspacePath));
    assert.equal(job.taskSummary, "Inspect the authentication boundary.");
    assert.equal(await readFile(job.taskPath, "utf8"), "Inspect the authentication boundary.");
    assert.equal((await stat(job.directoryPath)).mode & 0o077, 0);
    assert.equal((await stat(job.taskPath)).mode & 0o077, 0);

    assert.deepEqual(await store.readJob({ jobId: job.id }), job);
    assert.deepEqual(await store.listJobs(), [job]);

    const otherStore = await createJobStore({ agentDirectory, workspacePath: otherWorkspacePath });
    await assert.rejects(otherStore.readJob({ jobId: job.id }), /Subagent job not found/u);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("worker completes a queued job and preserves its final response", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-worker-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "child.mjs");
  await mkdir(workspacePath);
  await writeFile(
    childPath,
    `process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Inspected boundary."}],stopReason:"stop"}}) + "\\n");\n`,
    "utf8"
  );

  try {
    const store = await createJobStore({ agentDirectory, workspacePath });
    const queued = await store.createQueuedJob({
      task: "Inspect the boundary.",
      childCommand: process.execPath,
      childArgs: [childPath]
    });

    await runJobWorker({ store, jobId: queued.id });

    const completed = await store.readJob({ jobId: queued.id });
    assert.equal(completed.kind, "completed");
    assert.equal(await readFile(completed.resultPath, "utf8"), "Inspected boundary.");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("worker records launch, exit, and response failures", async (testContext) => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-worker-failure-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  await mkdir(workspacePath);

  try {
    const cases = [
      {
        name: "launch failure",
        childCommand: join(rootPath, "missing-command"),
        childArgs: [] as string[],
        expectedError: /failed to launch/u
      },
      {
        name: "non-zero exit",
        source: `process.stderr.write("provider unavailable\\n"); process.exit(7);\n`,
        expectedError: /provider unavailable/u
      },
      {
        name: "non-zero exit without stderr",
        source: `process.exit(9);\n`,
        expectedError: /exited with code 9/u
      },
      {
        name: "malformed output",
        source: `process.stdout.write("not-json\\n");\n`,
        expectedError: /no final response/u
      },
      {
        name: "missing final output",
        source: `process.stdout.write(JSON.stringify({type:"message_end",message:{role:"user"}}) + "\\n");\n`,
        expectedError: /no final response/u
      }
    ];

    for (const failureCase of cases) {
      await testContext.test(failureCase.name, async () => {
        let childCommand = failureCase.childCommand ?? process.execPath;
        let childArgs = failureCase.childArgs ?? [];
        if (failureCase.source) {
          const childPath = join(rootPath, `${failureCase.name.replaceAll(" ", "-")}.mjs`);
          await writeFile(childPath, failureCase.source, "utf8");
          childCommand = process.execPath;
          childArgs = [childPath];
        }

        const store = await createJobStore({ agentDirectory, workspacePath });
        const queued = await store.createQueuedJob({
          task: `Test ${failureCase.name}.`,
          childCommand,
          childArgs
        });

        await runJobWorker({ store, jobId: queued.id });

        const failed = await store.readJob({ jobId: queued.id });
        assert.equal(failed.kind, "failed");
        assert.match(failed.error, failureCase.expectedError);
      });
    }
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("cancellation terminates the child owned by the worker", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-worker-cancel-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "slow-child.mjs");
  await mkdir(workspacePath);
  await writeFile(
    childPath,
    `setTimeout(() => process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Too late."}],stopReason:"stop"}}) + "\\n"), 2_000);\n`,
    "utf8"
  );

  try {
    const store = await createJobStore({ agentDirectory, workspacePath });
    const queued = await store.createQueuedJob({
      task: "Run until cancelled.",
      childCommand: process.execPath,
      childArgs: [childPath]
    });
    const worker = runJobWorker({ store, jobId: queued.id });

    await waitForJobKind({ store, jobId: queued.id, kind: "running" });
    const requested = await store.requestCancellation({ jobId: queued.id });
    assert.equal(requested.kind, "cancel_requested");
    await worker;

    assert.equal((await store.readJob({ jobId: queued.id })).kind, "cancelled");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

type WaitForJobKindParams = {
  store: Awaited<ReturnType<typeof createJobStore>>;
  jobId: string;
  kind: "running";
};

async function waitForJobKind({ store, jobId, kind }: WaitForJobKindParams): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await store.readJob({ jobId })).kind === kind) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Job did not reach ${kind}.`);
}

test("start returns before completion and a later store can wait for the result", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-service-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "delayed-child.mjs");
  await mkdir(workspacePath);
  await writeFile(
    childPath,
    `setTimeout(() => process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Delayed result."}],stopReason:"stop"}}) + "\\n"), 300);\n`,
    "utf8"
  );

  try {
    const started = await startSubagentJob({
      agentDirectory,
      workspacePath,
      task: "Finish later.",
      childCommand: process.execPath,
      childArgs: [childPath]
    });
    assert.ok(started.kind === "queued" || started.kind === "running");

    const laterStore = await createJobStore({ agentDirectory, workspacePath });
    const completed = await waitForSubagentJob({ store: laterStore, jobId: started.id });
    assert.equal(completed.kind, "completed");
    assert.equal(await readFile(completed.resultPath, "utf8"), "Delayed result.");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("completed job output is bounded while preserving its stable result path", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-output-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  await mkdir(workspacePath);

  try {
    const store = await createJobStore({ agentDirectory, workspacePath });
    const queued = await store.createQueuedJob({
      task: "Produce a large result.",
      childCommand: "pi",
      childArgs: []
    });
    await store.markRunning({ jobId: queued.id });
    const resultPath = join(queued.directoryPath, "result.md");
    await writeFile(resultPath, "large output line\n".repeat(10_000), { encoding: "utf8", mode: 0o600 });
    const completed = await store.markCompleted({ jobId: queued.id, resultPath });

    const result = await formatJobResult({ action: "wait", job: completed });
    const content = result.content[0];
    assert.equal(content?.type, "text");
    if (content?.type !== "text") assert.fail("Expected text output.");
    assert.match(content.text, /Output truncated/u);
    assert.match(content.text, new RegExp(resultPath.replaceAll("/", "\\/"), "u"));
    assert.equal(result.details.kind, "job");
    if (result.details.kind !== "job") assert.fail("Expected job details.");
    assert.equal(result.details.job.resultPath, resultPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("job list is bounded to the most recent jobs", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-list-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  await mkdir(workspacePath);

  try {
    const store = await createJobStore({ agentDirectory, workspacePath });
    for (let index = 0; index < 25; index += 1) {
      await store.createQueuedJob({
        task: `Job ${String(index).padStart(2, "0")}`,
        childCommand: "pi",
        childArgs: []
      });
    }

    const result = formatJobList(await store.listJobs());
    assert.equal(result.details.kind, "list");
    assert.equal(result.details.jobs.length, 20);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("aborting wait leaves the detached job running", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-job-wait-abort-test-"));
  const agentDirectory = join(rootPath, "agent");
  const workspacePath = join(rootPath, "workspace");
  const childPath = join(rootPath, "delayed-child.mjs");
  await mkdir(workspacePath);
  await writeFile(
    childPath,
    `setTimeout(() => process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Still completed."}],stopReason:"stop"}}) + "\\n"), 300);\n`,
    "utf8"
  );

  try {
    const started = await startSubagentJob({
      agentDirectory,
      workspacePath,
      task: "Keep running after wait aborts.",
      childCommand: process.execPath,
      childArgs: [childPath]
    });
    const store = await createJobStore({ agentDirectory, workspacePath });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(waitForSubagentJob({ store, jobId: started.id, signal: controller.signal }), /aborted/u);
    const current = await store.readJob({ jobId: started.id });
    assert.ok(current.kind === "queued" || current.kind === "running");

    assert.equal((await waitForSubagentJob({ store, jobId: started.id })).kind, "completed");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
