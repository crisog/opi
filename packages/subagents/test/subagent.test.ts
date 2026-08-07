import assert from "node:assert/strict";
import test from "node:test";
import { buildChildArgs, parseChildResponse } from "../src/index.ts";

test("builds an isolated child invocation that inherits model and thinking", () => {
  const args = buildChildArgs({
    isProjectTrusted: true,
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-luna"
    },
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
