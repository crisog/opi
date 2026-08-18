import { readFile } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { formatSchedule } from "./scheduler.ts";
import type { LatestSchedulerRun, StoredSchedulerTask } from "./scheduler-store.ts";

export type SchedulerRunStatus = LatestSchedulerRun["kind"] | "never_run";

export type SchedulerTaskView = {
  id: string;
  schedule: string;
  status: SchedulerRunStatus;
  instructionsSummary: string;
  workingDirectory: string;
  createdAt: string;
  tools: string[];
  skills: string[];
  model?: string;
  thinkingLevel?: string;
  startedAt?: string;
  finishedAt?: string;
  resultPath?: string;
  result?: string;
  stdoutPath: string;
  stderrPath: string;
  error?: string;
};

type SchedulerTaskDetails = {
  kind: "task";
  action: "create" | "status";
  task: SchedulerTaskView;
};

type SchedulerListDetails = {
  kind: "list";
  action: "list";
  tasks: SchedulerTaskView[];
};

type SchedulerRemoveDetails = {
  kind: "remove";
  action: "remove";
  id: string;
};

type SchedulerProgressDetails = {
  kind: "progress";
  action: "create";
  id: string;
};

export type SchedulerToolDetails =
  SchedulerTaskDetails | SchedulerListDetails | SchedulerRemoveDetails | SchedulerProgressDetails;

export type SchedulerToolResult = {
  content: [{ type: "text"; text: string }];
  details: SchedulerToolDetails;
};

type TaskAndRunParams = {
  task: StoredSchedulerTask;
  run: LatestSchedulerRun | null;
};

type FormatTaskResultParams = TaskAndRunParams & {
  action: SchedulerTaskDetails["action"];
};

function buildTaskView({ task, run }: TaskAndRunParams): SchedulerTaskView {
  return {
    id: task.id,
    schedule: formatSchedule(task.schedule),
    status: run?.kind ?? "never_run",
    instructionsSummary: task.instructionsSummary,
    workingDirectory: task.workingDirectory,
    createdAt: task.createdAt,
    tools: [...task.tools],
    skills: [...task.skills],
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(task.thinkingLevel === undefined ? {} : { thinkingLevel: task.thinkingLevel }),
    ...(run === null ? {} : { startedAt: run.startedAt }),
    ...(run?.kind === "completed" ? { finishedAt: run.finishedAt, resultPath: run.resultPath } : {}),
    ...(run?.kind === "failed" ? { finishedAt: run.finishedAt, error: run.error } : {}),
    stdoutPath: task.stdoutPath,
    stderrPath: task.stderrPath
  };
}

function formatTaskMetadata(view: SchedulerTaskView): string {
  const model = view.model ?? "Pi default";
  const thinkingLevel = view.thinkingLevel ?? "Pi default";
  const skills = view.skills.length > 0 ? view.skills.join(", ") : "none";
  const lines = [
    `Scheduled task ${view.id}: ${view.status}`,
    `Schedule: ${view.schedule}`,
    `Instructions: ${view.instructionsSummary}`,
    `Directory: ${view.workingDirectory}`,
    `Model: ${model}`,
    `Thinking: ${thinkingLevel}`,
    `Tools: ${view.tools.join(", ")}`,
    `Skills: ${skills}`
  ];
  if (view.startedAt) lines.push(`Started: ${view.startedAt}`);
  if (view.finishedAt) lines.push(`Finished: ${view.finishedAt}`);
  if (view.error) lines.push(`Error: ${view.error}`);
  if (view.resultPath) lines.push(`Full result: ${view.resultPath}`);
  lines.push(`Output: ${view.stdoutPath}`, `Errors: ${view.stderrPath}`);
  return lines.join("\n");
}

async function formatCompletedOutput(run: Extract<LatestSchedulerRun, { kind: "completed" }>): Promise<string> {
  const output = await readFile(run.resultPath, "utf8");
  const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncated.truncated) return output;
  return `${truncated.content}\n\n[Output truncated from ${formatSize(truncated.totalBytes)}. Full output: ${run.resultPath}]`;
}

export function formatSchedulerList(entries: TaskAndRunParams[]): SchedulerToolResult {
  const tasks = entries.map(buildTaskView);
  const lines = tasks.map(
    (task) =>
      `${task.id} ${task.status} ${task.finishedAt ?? task.startedAt ?? task.createdAt} ${task.schedule} — ${task.instructionsSummary}`
  );
  return {
    content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No scheduled tasks in this workspace." }],
    details: { kind: "list", action: "list", tasks }
  };
}

export async function formatSchedulerTaskResult({
  action,
  task,
  run
}: FormatTaskResultParams): Promise<SchedulerToolResult> {
  const view = buildTaskView({ task, run });
  let text = formatTaskMetadata(view);
  if (action === "create") text = `Created scheduled task ${task.id}.\n${text}`;
  let result: string | undefined;
  if (action === "status" && run?.kind === "completed") {
    result = await formatCompletedOutput(run);
    text = `${text}\n\n${result}`;
  }
  return {
    content: [{ type: "text", text }],
    details: {
      kind: "task",
      action,
      task: result === undefined ? view : { ...view, result }
    }
  };
}

export function formatSchedulerRemoval(id: string): SchedulerToolResult {
  return {
    content: [{ type: "text", text: `Removed scheduled task: ${id}` }],
    details: { kind: "remove", action: "remove", id }
  };
}
