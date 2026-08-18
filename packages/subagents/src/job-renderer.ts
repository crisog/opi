import { Text } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { JobToolDetails, JobView } from "./job-output.ts";

const SHORT_ID_LENGTH = 8;
const MAX_TASK_PREVIEW_LENGTH = 60;

type JobCallArgs =
  | {
      action: "start";
      task: string;
    }
  | {
      action: "status" | "wait" | "cancel";
      jobId: string;
    }
  | {
      action: "list";
    };

type RenderJobCallParams = {
  args: JobCallArgs;
  theme: Theme;
};

type RenderJobResultParams = {
  details: JobToolDetails;
  isPartial: boolean;
  expanded: boolean;
  theme: Theme;
};

type StatusPresentation = {
  icon: string;
  color: ThemeColor;
};

type RenderJobLineParams = {
  job: JobView;
  action: string;
  theme: Theme;
  isPartial: boolean;
};

function shortenId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

function previewTask(task: string): string {
  const normalized = task.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_TASK_PREVIEW_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TASK_PREVIEW_LENGTH - 1)}…`;
}

function getStatusPresentation(status: JobView["status"]): StatusPresentation {
  if (status === "completed") return { icon: "✓", color: "success" };
  if (status === "failed") return { icon: "✗", color: "error" };
  if (status === "cancelled") return { icon: "■", color: "warning" };
  if (status === "cancel_requested") return { icon: "◐", color: "warning" };
  if (status === "running") return { icon: "◐", color: "accent" };
  return { icon: "○", color: "muted" };
}

function renderJobLine({ job, action, theme, isPartial }: RenderJobLineParams): string {
  const presentation = isPartial ? { icon: "◐", color: "warning" as const } : getStatusPresentation(job.status);
  return [
    theme.fg(presentation.color, presentation.icon),
    theme.fg("toolTitle", theme.bold(action.toUpperCase())),
    theme.fg("accent", shortenId(job.id)),
    theme.fg("muted", `— ${job.status}`)
  ].join(" ");
}

export function renderJobCall({ args, theme }: RenderJobCallParams): Text {
  let target = "";
  if (args.action === "start") target = ` “${previewTask(args.task)}”`;
  if (args.action === "status" || args.action === "wait" || args.action === "cancel") {
    target = ` ${shortenId(args.jobId)}`;
  }
  const text =
    theme.fg("toolTitle", theme.bold("subagent job ")) + theme.fg("accent", args.action) + theme.fg("dim", target);
  return new Text(text, 0, 0);
}

export function renderJobResult({ details, isPartial, expanded, theme }: RenderJobResultParams): Text {
  if (details.kind === "list") {
    const lines = [theme.fg("toolTitle", theme.bold(`subagent jobs (${details.jobs.length})`))];
    for (const job of details.jobs) {
      const presentation = getStatusPresentation(job.status);
      const id = expanded ? job.id : shortenId(job.id);
      lines.push(
        `${theme.fg(presentation.color, presentation.icon)} ${theme.fg("accent", id)} ${theme.fg(presentation.color, job.status)} ${theme.fg("dim", job.taskSummary)}`
      );
      if (expanded) {
        lines.push(theme.fg("muted", `  updated ${job.updatedAt}`));
        if (job.error) lines.push(theme.fg("error", `  ${job.error}`));
        if (job.resultPath) lines.push(theme.fg("dim", `  result ${job.resultPath}`));
      }
    }
    if (details.jobs.length === 0) lines.push(theme.fg("muted", "No jobs in this workspace."));
    return new Text(lines.join("\n"), 0, 0);
  }

  const lines = [
    renderJobLine({
      job: details.job,
      action: details.action,
      theme,
      isPartial
    }),
    theme.fg("dim", details.job.taskSummary)
  ];
  if (expanded) {
    lines.push(theme.fg("muted", `id ${details.job.id}`));
    lines.push(theme.fg("muted", `created ${details.job.createdAt}`));
    lines.push(theme.fg("muted", `updated ${details.job.updatedAt}`));
    if (details.job.error) lines.push(theme.fg("error", details.job.error));
    if (details.job.resultPath) lines.push(theme.fg("dim", `result ${details.job.resultPath}`));
  }
  return new Text(lines.join("\n"), 0, 0);
}
