import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagent, {
  buildChildArgs,
  buildJobChildArgs,
  buildReviewChildArgs,
  executeReview,
  executeTask,
  formatReviewResult,
  parseChildResponse,
  parseReviewResult,
  resolveRequestedSkills
} from "../src/index.ts";

test("registers synchronous and durable subagent tools", () => {
  const toolNames: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      toolNames.push(tool.name);
    }
  } as unknown as ExtensionAPI;

  registerSubagent(pi);

  assert.deepEqual(toolNames, ["subagent", "subagent_job"]);
});

test("builds an isolated child invocation with the selected model and thinking level", () => {
  const args = buildChildArgs({
    isProjectTrusted: true,
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high",
    task: "Review the diff"
  });

  assert.deepEqual(args, [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--approve",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "high",
    "Review the diff"
  ]);
});

test("denies project-local resources when the parent project is untrusted", () => {
  const args = buildChildArgs({
    isProjectTrusted: false,
    task: "Inspect the repository"
  });

  assert.deepEqual(args, [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-approve",
    "Inspect the repository"
  ]);
});

test("builds a child invocation with explicitly required skills", () => {
  const args = buildChildArgs({
    isProjectTrusted: true,
    skills: [
      {
        name: "planout",
        path: "/skills/planout/SKILL.md"
      }
    ],
    task: "Plan docs/spec.md"
  });

  assert.deepEqual(args, [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--approve",
    "--skill",
    "/skills/planout/SKILL.md",
    "--append-system-prompt",
    "You must use the following skills for this delegated task:\n- planout: /skills/planout/SKILL.md\nRead each required SKILL.md in full before starting, follow its instructions, and resolve relative references from its containing directory.",
    "Plan docs/spec.md"
  ]);
});

test("resolves a requested skill from Pi's available commands", () => {
  const commands: ReturnType<ExtensionAPI["getCommands"]> = [
    {
      name: "skill:planout",
      description: "Write an implementation plan",
      source: "skill",
      sourceInfo: {
        path: "/skills/planout/SKILL.md",
        source: "settings",
        scope: "user",
        origin: "top-level"
      }
    }
  ];

  assert.deepEqual(resolveRequestedSkills({ commands, skillNames: ["planout"] }), [
    {
      name: "planout",
      path: "/skills/planout/SKILL.md"
    }
  ]);
});

test("rejects a requested skill that is not available to Pi", () => {
  assert.throws(
    () => resolveRequestedSkills({ commands: [], skillNames: ["missing-skill"] }),
    /Required subagent skill is not available: missing-skill/
  );
});

test("builds a read-only isolated review invocation", () => {
  const args = buildReviewChildArgs({
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high",
    task: "Review from an immutable patch"
  });

  assert.deepEqual(args, [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    "read,grep,find,ls",
    "--system-prompt",
    "You are an independent code reviewer. Inspect the requested scope without modifying it, ground findings in repository evidence, and return only the requested verdict format.",
    "--approve",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "high",
    "Review from an immutable patch"
  ]);
});

test("builds a read-only isolated durable job invocation", () => {
  const args = buildJobChildArgs({
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high"
  });

  assert.deepEqual(args, [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    "read,grep,find,ls",
    "--system-prompt",
    "You are a read-only analysis subagent. Inspect the requested scope without modifying it and return a concise, evidence-grounded result.",
    "--approve",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "high"
  ]);
});

test("parses and formats a review verdict", () => {
  const result = parseReviewResult(
    JSON.stringify({
      verdict: "changes_requested",
      summary: "Cancellation leaves stale state.",
      findings: [
        {
          severity: "high",
          location: "src/jobs.ts:84",
          claim: "The abort path exits before clearing the active marker."
        }
      ]
    })
  );

  assert.equal(
    formatReviewResult(result),
    "CHANGES_REQUESTED: Cancellation leaves stale state.\n[high] src/jobs.ts:84 — The abort path exits before clearing the active marker."
  );
});

test("rejects an approval that contains findings", () => {
  const output = JSON.stringify({
    verdict: "approve",
    summary: "Looks good.",
    findings: [{ severity: "low", location: "src/a.ts:1", claim: "Still an issue." }]
  });

  assert.throws(() => parseReviewResult(output), /approve verdict must not contain findings/);
});

test("rejects a review when the worktree changes during inspection", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "opi-review-stale-test-"));
  const sourcePath = join(rootPath, "value.ts");
  const git = (args: string[]): string => execFileSync("git", args, { cwd: rootPath, encoding: "utf8" });

  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Opi Test"]);
    git(["config", "user.email", "opi@example.test"]);
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    git(["add", "value.ts"]);
    git(["commit", "-qm", "add value"]);
    await writeFile(sourcePath, "export const value = 2;\n", "utf8");
    git(["add", "value.ts"]);
    git(["commit", "-qm", "change value"]);

    const pi = {
      async exec(command: string, args: string[], options?: { cwd?: string }) {
        if (command === "git") {
          return {
            stdout: execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" }),
            stderr: "",
            code: 0,
            killed: false
          };
        }
        await writeFile(sourcePath, "export const value = 3;\n", "utf8");
        return {
          stdout: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: '{"verdict":"approve","summary":"Looks good.","findings":[]}' }],
              stopReason: "stop"
            }
          }),
          stderr: "",
          code: 0,
          killed: false
        };
      }
    } as unknown as ExtensionAPI;

    await assert.rejects(
      executeReview({ pi, cwd: rootPath, base: "HEAD~1", brief: "Review the value change." }),
      /became stale/
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("runs a task from a protected temporary prompt using the current Pi runtime", async () => {
  let promptPath: string | undefined;
  const currentScript = process.argv[1];
  assert.ok(currentScript);

  const pi = {
    async exec(command: string, args: string[]) {
      assert.equal(command, process.execPath);
      assert.equal(args[0], currentScript);
      assert.ok(args.includes("--no-approve"));

      const promptArgument = args.at(-1);
      if (!promptArgument?.startsWith("@")) assert.fail("Expected a task file argument.");
      promptPath = promptArgument.slice(1);
      assert.equal(await readFile(promptPath, "utf8"), "Inspect authentication boundaries.");

      const promptInfo = await stat(promptPath);
      assert.equal(promptInfo.mode & 0o077, 0);

      return {
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Authentication uses scoped credentials." }],
            stopReason: "stop"
          }
        }),
        stderr: "",
        code: 0,
        killed: false
      };
    }
  } as unknown as ExtensionAPI;

  const result = await executeTask({
    pi,
    cwd: "/project",
    isProjectTrusted: false,
    task: "Inspect authentication boundaries."
  });

  assert.equal(result.text, "Authentication uses scoped credentials.");
  if (!promptPath) assert.fail("Expected the child prompt path to be captured.");
  await assert.rejects(access(promptPath), { code: "ENOENT" });
});

test("returns the final assistant response from Pi JSON output", () => {
  const stdout = [
    "not json",
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "First response" }],
        stopReason: "toolUse"
      }
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final response" }],
        stopReason: "stop"
      }
    })
  ].join("\n");

  assert.deepEqual(parseChildResponse(stdout), {
    text: "Final response",
    stopReason: "stop",
    errorMessage: undefined
  });
});
