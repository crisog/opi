import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SUBAGENT_PARAMS = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "A self-contained task for the isolated child agent"
  })
});

type ChildResponse = {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
};

type JsonObject = Record<string, unknown>;

type FormattedOutput = {
  text: string;
  outputPath?: string;
};

type BuildChildArgsParams = {
  isProjectTrusted: boolean;
  model?: {
    provider: string;
    id: string;
  };
  thinkingLevel?: string;
  task: string;
};

export function buildChildArgs({ isProjectTrusted, model, thinkingLevel, task }: BuildChildArgsParams): string[] {
  const args = ["--mode", "json", "--print", "--no-session", "--no-extensions"];
  if (isProjectTrusted) args.push("--approve");
  if (model) args.push("--model", `${model.provider}/${model.id}`);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  args.push(task);
  return args;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  const textParts: string[] = [];
  for (const part of content) {
    if (!isJsonObject(part) || part["type"] !== "text" || typeof part["text"] !== "string") continue;
    textParts.push(part["text"]);
  }

  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

export function parseChildResponse(stdout: string): ChildResponse {
  let response: ChildResponse = {};

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isJsonObject(event) || event["type"] !== "message_end") continue;
    const message = event["message"];
    if (!isJsonObject(message) || message["role"] !== "assistant") continue;

    response = {
      text: textFromContent(message["content"]),
      stopReason: typeof message["stopReason"] === "string" ? message["stopReason"] : undefined,
      errorMessage: typeof message["errorMessage"] === "string" ? message["errorMessage"] : undefined
    };
  }

  return response;
}

async function formatOutput(output: string): Promise<FormattedOutput> {
  const truncated = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES
  });
  if (!truncated.truncated) return { text: output };

  const directory = await mkdtemp(join(tmpdir(), "opi-subagent-"));
  const outputPath = join(directory, "output.md");
  await writeFile(outputPath, output, "utf8");

  return {
    text: `${truncated.content}\n\n[Output truncated from ${formatSize(truncated.totalBytes)}. Full output: ${outputPath}]`,
    outputPath
  };
}

export default function registerSubagent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate one self-contained task to an isolated Pi child process and return its final response.",
    promptSnippet: "Delegate a focused task to an isolated Pi child process",
    promptGuidelines: [
      "Use subagent when an independent context would help with research, investigation, or review.",
      "Give subagent a self-contained task because it cannot see the parent conversation."
    ],
    parameters: SUBAGENT_PARAMS,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Subagent running..." }],
        details: { status: "running" }
      });

      const args = buildChildArgs({
        isProjectTrusted: ctx.isProjectTrusted(),
        model: ctx.model,
        thinkingLevel: ctx.thinkingLevel,
        task: params.task
      });

      const child = await pi.exec("pi", args, {
        cwd: ctx.cwd,
        signal
      });

      if (child.killed) throw new Error("Subagent was cancelled.");

      const response = parseChildResponse(child.stdout);
      if (child.code !== 0) {
        const reason = response.errorMessage || child.stderr.trim() || `Pi exited with code ${child.code}.`;
        throw new Error(`Subagent failed: ${reason}`);
      }
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(`Subagent ${response.stopReason}: ${response.errorMessage ?? "No error details returned."}`);
      }
      if (!response.text) throw new Error("Subagent returned no final response.");

      const output = await formatOutput(response.text);
      return {
        content: [{ type: "text", text: output.text }],
        details: {
          status: "completed",
          outputPath: output.outputPath
        }
      };
    }
  });
}
