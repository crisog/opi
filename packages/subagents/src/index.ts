import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const REVIEW_KINDS = ["task", "review"] as const;
const REVIEW_SEVERITIES = ["high", "medium", "low"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REVIEW_VERDICTS = ["approve", "changes_requested", "review_failed"] as const;
const REVIEW_READ_ONLY_TOOLS = "read,grep,find,ls";
const REVIEW_SYSTEM_PROMPT =
  "You are an independent code reviewer. Inspect the requested scope without modifying it, ground findings in repository evidence, and return only the requested verdict format.";
const MAX_REVIEW_BASE_LENGTH = 200;
const MAX_REVIEW_BRIEF_LENGTH = 8_000;
const MAX_REVIEW_SUMMARY_LENGTH = 500;
const MAX_REVIEW_FINDINGS = 20;
const MAX_REVIEW_LOCATION_LENGTH = 500;
const MAX_REVIEW_CLAIM_LENGTH = 1_000;
const MAX_SKILL_NAME_LENGTH = 64;
const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const REVIEW_FINDING_SCHEMA = Type.Object(
  {
    severity: Type.Union([
      Type.Literal(REVIEW_SEVERITIES[0]),
      Type.Literal(REVIEW_SEVERITIES[1]),
      Type.Literal(REVIEW_SEVERITIES[2])
    ]),
    location: Type.String({ minLength: 1, maxLength: MAX_REVIEW_LOCATION_LENGTH }),
    claim: Type.String({ minLength: 1, maxLength: MAX_REVIEW_CLAIM_LENGTH })
  },
  { additionalProperties: false }
);

const REVIEW_RESULT_SCHEMA = Type.Object(
  {
    verdict: Type.Union([
      Type.Literal(REVIEW_VERDICTS[0]),
      Type.Literal(REVIEW_VERDICTS[1]),
      Type.Literal(REVIEW_VERDICTS[2])
    ]),
    summary: Type.String({ minLength: 1, maxLength: MAX_REVIEW_SUMMARY_LENGTH }),
    findings: Type.Array(REVIEW_FINDING_SCHEMA, { maxItems: MAX_REVIEW_FINDINGS })
  },
  { additionalProperties: false }
);

const validateReviewResult = Compile(REVIEW_RESULT_SCHEMA);

const THINKING_LEVEL_SCHEMA = Type.Unsafe<(typeof THINKING_LEVELS)[number]>({
  type: "string",
  enum: THINKING_LEVELS,
  description: "Pi thinking level; defaults to the parent thinking level"
});

const SUBAGENT_PARAMS = Type.Object({
  kind: Type.Optional(
    Type.Union([Type.Literal(REVIEW_KINDS[0]), Type.Literal(REVIEW_KINDS[1])], {
      description: "Task or committed-change review"
    })
  ),
  task: Type.String({
    minLength: 1,
    description: "Self-contained task or factual review brief"
  }),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Pi model pattern or provider/model ID; defaults to the parent model"
    })
  ),
  thinkingLevel: Type.Optional(THINKING_LEVEL_SCHEMA),
  skills: Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        maxLength: MAX_SKILL_NAME_LENGTH,
        pattern: SKILL_NAME_PATTERN,
        description: "Required skill name without the skill: prefix"
      }),
      { description: "Skills the task subagent must load and follow" }
    )
  ),
  base: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_REVIEW_BASE_LENGTH,
      description: "Review base ref"
    })
  )
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

type ChildModel = {
  provider: string;
  id: string;
};

type ChildSkill = {
  name: string;
  path: string;
};

type BuildChildArgsParams = {
  isProjectTrusted: boolean;
  model?: string;
  thinkingLevel?: string;
  skills?: ChildSkill[];
  task: string;
};

type ResolveRequestedSkillsParams = {
  commands: ReturnType<ExtensionAPI["getCommands"]>;
  skillNames: string[];
};

type BuildReviewChildArgsParams = {
  model?: string;
  thinkingLevel?: string;
  task: string;
};

export type ReviewFinding = Static<typeof REVIEW_FINDING_SCHEMA>;
export type ReviewResult = Static<typeof REVIEW_RESULT_SCHEMA>;

type BuildReviewPromptParams = {
  patchPath: string;
  briefPath: string;
  baseSha: string;
  headSha: string;
};

type RunGitParams = {
  pi: ExtensionAPI;
  cwd: string;
  args: string[];
  signal?: AbortSignal;
};

type ReviewExecutionParams = {
  pi: ExtensionAPI;
  cwd: string;
  base: string;
  brief: string;
  model?: string;
  thinkingLevel?: string;
  signal?: AbortSignal;
};

export function buildChildArgs({
  isProjectTrusted,
  model,
  thinkingLevel,
  skills = [],
  task
}: BuildChildArgsParams): string[] {
  const args = ["--mode", "json", "--print", "--no-session", "--no-extensions"];
  if (isProjectTrusted) args.push("--approve");
  for (const skill of skills) args.push("--skill", skill.path);
  if (skills.length > 0) args.push("--append-system-prompt", buildRequiredSkillsPrompt(skills));
  appendModelArgs({ args, model, thinkingLevel });
  args.push(task);
  return args;
}

function buildRequiredSkillsPrompt(skills: ChildSkill[]): string {
  const skillLines = skills.map((skill) => `- ${skill.name}: ${skill.path}`).join("\n");
  return `You must use the following skills for this delegated task:\n${skillLines}\nRead each required SKILL.md in full before starting, follow its instructions, and resolve relative references from its containing directory.`;
}

export function resolveRequestedSkills({ commands, skillNames }: ResolveRequestedSkillsParams): ChildSkill[] {
  const skills: ChildSkill[] = [];
  const resolvedNames = new Set<string>();

  for (const skillName of skillNames) {
    if (resolvedNames.has(skillName)) continue;
    const command = commands.find(
      (candidate) => candidate.source === "skill" && candidate.name === `skill:${skillName}`
    );
    if (!command) throw new Error(`Required subagent skill is not available: ${skillName}`);
    skills.push({ name: skillName, path: command.sourceInfo.path });
    resolvedNames.add(skillName);
  }

  return skills;
}

export function buildReviewChildArgs({ model, thinkingLevel, task }: BuildReviewChildArgsParams): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    REVIEW_READ_ONLY_TOOLS,
    "--system-prompt",
    REVIEW_SYSTEM_PROMPT,
    "--approve"
  ];
  appendModelArgs({ args, model, thinkingLevel });
  args.push(task);
  return args;
}

type AppendModelArgsParams = {
  args: string[];
  model?: string;
  thinkingLevel?: string;
};

function appendModelArgs({ args, model, thinkingLevel }: AppendModelArgsParams): void {
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
}

function formatChildModel(model: ChildModel | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
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

export function parseReviewResult(output: string): ReviewResult {
  let value: unknown;
  try {
    value = JSON.parse(unwrapJsonFence(output));
  } catch (error) {
    throw new Error(`Review returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }

  if (!validateReviewResult.Check(value)) {
    const firstError = validateReviewResult.Errors(value)[0];
    throw new Error(`Review result does not match the required shape${firstError ? `: ${firstError.message}` : "."}`);
  }

  const result: ReviewResult = {
    verdict: value.verdict,
    summary: normalizeReviewText({ value: value.summary, label: "Review summary" }),
    findings: value.findings.map((finding) => ({
      severity: finding.severity,
      location: normalizeReviewText({ value: finding.location, label: "Review finding location" }),
      claim: normalizeReviewText({ value: finding.claim, label: "Review finding claim" })
    }))
  };

  if (result.verdict === "approve" && result.findings.length > 0) {
    throw new Error("An approve verdict must not contain findings.");
  }
  if (result.verdict === "changes_requested" && result.findings.length === 0) {
    throw new Error("A changes_requested verdict must contain at least one finding.");
  }
  if (result.verdict === "review_failed" && result.findings.length > 0) {
    throw new Error("A review_failed verdict must not contain findings.");
  }

  return result;
}

export function formatReviewResult(result: ReviewResult): string {
  const heading = `${result.verdict.toUpperCase()}: ${result.summary}`;
  const findings = result.findings.map((finding) => `[${finding.severity}] ${finding.location} — ${finding.claim}`);
  return [heading, ...findings].join("\n");
}

function unwrapJsonFence(output: string): string {
  const trimmed = output.trim();
  const prefix = "```json\n";
  const suffix = "\n```";
  if (trimmed.startsWith(prefix) && trimmed.endsWith(suffix)) {
    return trimmed.slice(prefix.length, -suffix.length);
  }
  return trimmed;
}

type NormalizeReviewTextParams = {
  value: string;
  label: string;
};

function normalizeReviewText({ value, label }: NormalizeReviewTextParams): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error(`${label} must not be blank.`);
  return normalized;
}

export function buildReviewPrompt({ patchPath, briefPath, baseSha, headSha }: BuildReviewPromptParams): string {
  return `# Independent Code Review

You are a reviewer, not an author. Inspect the committed changes without modifying the repository.

Review scope:
- Base SHA: ${baseSha}
- Head SHA: ${headSha}
- Immutable patch: ${patchPath}
- Review brief: ${briefPath}

Read the entire patch and review brief, using read offsets when needed, and inspect relevant source and tests with read-only tools. Treat the brief as context rather than evidence that the implementation is correct. Ignore claims of successful completion, authorship, or prior review.

Prioritize concrete behavioral correctness, security, regression, and missing-test risks over style. Ground every finding in inspected code and give a precise file, line, or symbol location. Judge explicit non-goals and best-effort behavior against what they actually claim. Return review_failed if the scope cannot be inspected reliably.

Return exactly one JSON object with no prose or Markdown fence:
{"verdict":"approve|changes_requested|review_failed","summary":"short summary","findings":[{"severity":"high|medium|low","location":"path:line or symbol","claim":"specific grounded problem"}]}

Use approve only when there are no actionable findings. Use changes_requested with one to ${MAX_REVIEW_FINDINGS} findings when fixes are needed. Use review_failed with no findings when no reliable verdict is possible.`;
}

async function runGit({ pi, cwd, args, signal }: RunGitParams): Promise<string> {
  const result = await pi.exec("git", args, { cwd, signal });
  if (result.killed) throw new Error("Independent review was cancelled.");
  if (result.code !== 0) throw new Error(`Git command failed: ${result.stderr.trim() || "unknown error"}`);
  return result.stdout;
}

export async function executeReview({
  pi,
  cwd,
  base,
  brief,
  model,
  thinkingLevel,
  signal
}: ReviewExecutionParams): Promise<{
  text: string;
  verdict: ReviewResult["verdict"];
  baseSha: string;
  headSha: string;
}> {
  signal?.throwIfAborted();
  const rootPath = (await runGit({ pi, cwd, args: ["rev-parse", "--show-toplevel"], signal })).trim();
  const status = await runGit({
    pi,
    cwd: rootPath,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal
  });
  if (status.length > 0) throw new Error("Independent review requires a clean working tree.");

  if (brief.length > MAX_REVIEW_BRIEF_LENGTH) {
    throw new Error(`Independent review brief must not exceed ${MAX_REVIEW_BRIEF_LENGTH} characters.`);
  }
  const normalizedBase = base.trim();
  if (!normalizedBase || normalizedBase.startsWith("-") || /[\p{Cc}]/u.test(normalizedBase)) {
    throw new Error("Independent review requires a valid Git base ref.");
  }
  const requestedBaseSha = (
    await runGit({
      pi,
      cwd: rootPath,
      args: ["rev-parse", "--verify", "--end-of-options", `${normalizedBase}^{commit}`],
      signal
    })
  ).trim();
  const headSha = (
    await runGit({
      pi,
      cwd: rootPath,
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
      signal
    })
  ).trim();
  const baseSha = (await runGit({ pi, cwd: rootPath, args: ["merge-base", requestedBaseSha, headSha], signal })).trim();
  const patch = await runGit({
    pi,
    cwd: rootPath,
    args: ["diff", "--no-ext-diff", "--find-renames", "--unified=80", baseSha, headSha, "--"],
    signal
  });
  if (!patch.trim()) throw new Error("Independent review found no committed changes in the requested range.");

  const directory = await mkdtemp(join(tmpdir(), "opi-review-"));
  const patchPath = join(directory, "changes.patch");
  const briefPath = join(directory, "brief.txt");
  try {
    await Promise.all([writeFile(patchPath, patch, "utf8"), writeFile(briefPath, brief, "utf8")]);
    const task = buildReviewPrompt({ patchPath, briefPath, baseSha, headSha });
    const child = await pi.exec("pi", buildReviewChildArgs({ model, thinkingLevel, task }), {
      cwd: rootPath,
      signal
    });
    if (child.killed) throw new Error("Independent review was cancelled.");

    const response = parseChildResponse(child.stdout);
    if (child.code !== 0) {
      const reason = response.errorMessage || child.stderr.trim() || `Pi exited with code ${child.code}.`;
      throw new Error(`Independent review failed: ${reason}`);
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`Independent review ${response.stopReason}: ${response.errorMessage ?? "No details returned."}`);
    }
    if (!response.text) throw new Error("Independent review returned no final response.");

    const currentHeadSha = (
      await runGit({ pi, cwd: rootPath, args: ["rev-parse", "--verify", "HEAD^{commit}"], signal })
    ).trim();
    const currentStatus = await runGit({
      pi,
      cwd: rootPath,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      signal
    });
    if (currentHeadSha !== headSha || currentStatus.length > 0) {
      throw new Error("Independent review became stale because the reviewed worktree changed.");
    }

    const result = parseReviewResult(response.text);
    if (result.verdict === "review_failed") throw new Error(`Independent review failed: ${result.summary}`);
    return {
      text: `${formatReviewResult(result)}\nscope: ${baseSha}..${headSha}`,
      verdict: result.verdict,
      baseSha,
      headSha
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    description: "Delegate one task to isolated Pi, optionally as a read-only committed-change review.",
    promptSnippet: "Delegate focused work or an independent review",
    promptGuidelines: [
      "Use kind=review with base for independent review of committed changes.",
      "Provide a self-contained task because the child cannot see this conversation.",
      "Pass skills to subagent when delegated work must follow specific available skills.",
      "Pass model or thinkingLevel to subagent only when delegated work needs an explicit override."
    ],
    parameters: SUBAGENT_PARAMS,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const kind = params.kind ?? "task";
      const model = params.model ?? formatChildModel(ctx.model);
      const thinkingLevel = params.thinkingLevel ?? ctx.thinkingLevel;
      onUpdate?.({
        content: [{ type: "text", text: kind === "review" ? "Independent review running..." : "Subagent running..." }],
        details: { status: "running", kind }
      });

      if (kind === "review") {
        if (params.skills && params.skills.length > 0) {
          throw new Error("Independent reviews do not support skills.");
        }
        if (!ctx.isProjectTrusted()) throw new Error("Independent review requires a trusted project.");
        if (!params.base) throw new Error("Independent review requires a Git base ref.");
        const review = await executeReview({
          pi,
          cwd: ctx.cwd,
          base: params.base,
          brief: params.task,
          model,
          thinkingLevel,
          signal
        });
        const output = await formatOutput(review.text);
        return {
          content: [{ type: "text", text: output.text }],
          details: {
            status: "completed",
            kind,
            verdict: review.verdict,
            baseSha: review.baseSha,
            headSha: review.headSha,
            outputPath: output.outputPath
          }
        };
      }

      const skills = resolveRequestedSkills({
        commands: pi.getCommands(),
        skillNames: params.skills ?? []
      });
      const args = buildChildArgs({
        isProjectTrusted: ctx.isProjectTrusted(),
        model,
        thinkingLevel,
        skills,
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
          kind,
          outputPath: output.outputPath
        }
      };
    }
  });
}
