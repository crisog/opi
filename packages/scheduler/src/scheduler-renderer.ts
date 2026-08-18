import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatSchedule, parseSchedule, type ScheduleInput } from "./scheduler.ts";
import type { SchedulerRunStatus, SchedulerTaskView, SchedulerToolDetails } from "./scheduler-output.ts";

const MAX_INSTRUCTIONS_PREVIEW_LENGTH = 60;

type SchedulerCallArgs =
  | {
      action: "create";
      id?: string;
      instructions?: string;
      schedule?: ScheduleInput;
    }
  | {
      action: "list";
    }
  | {
      action: "status" | "remove";
      id?: string;
    };

type RenderSchedulerCallParams = {
  args: SchedulerCallArgs;
  theme: Theme;
};

type RenderSchedulerResultParams = {
  details: SchedulerToolDetails;
  isPartial: boolean;
  expanded: boolean;
  theme: Theme;
};

type StatusPresentation = {
  icon: string;
  color: ThemeColor;
};

function previewInstructions(instructions: string | undefined): string {
  if (!instructions) return "";
  const normalized = instructions.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_INSTRUCTIONS_PREVIEW_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_INSTRUCTIONS_PREVIEW_LENGTH - 1)}…`;
}

function getStatusPresentation(status: SchedulerRunStatus): StatusPresentation {
  if (status === "completed") return { icon: "✓", color: "success" };
  if (status === "failed") return { icon: "✗", color: "error" };
  if (status === "running") return { icon: "◐", color: "accent" };
  return { icon: "○", color: "muted" };
}

function renderTaskLine(task: SchedulerTaskView, theme: Theme): string {
  const presentation = getStatusPresentation(task.status);
  const timestamp = task.finishedAt ?? task.startedAt ?? task.createdAt;
  return `${theme.fg(presentation.color, presentation.icon)} ${theme.fg("accent", task.id)} ${theme.fg(presentation.color, task.status)} ${theme.fg("dim", timestamp)} ${theme.fg("dim", task.schedule)} ${theme.fg("dim", task.instructionsSummary)}`;
}

function formatCallSchedule(schedule: ScheduleInput | undefined): string {
  if (!schedule) return "";
  try {
    return formatSchedule(parseSchedule(schedule));
  } catch {
    return "";
  }
}

export function renderSchedulerCall({ args, theme }: RenderSchedulerCallParams): Text {
  const id = "id" in args && args.id ? ` ${args.id}` : "";
  const preview = args.action === "create" ? previewInstructions(args.instructions) : "";
  const schedule = args.action === "create" ? formatCallSchedule(args.schedule) : "";
  const previewSuffix = preview ? ` “${preview}”` : "";
  const scheduleSuffix = schedule ? ` · ${schedule}` : "";
  const suffix = `${id}${previewSuffix}${scheduleSuffix}`;
  const text =
    theme.fg("toolTitle", theme.bold("scheduler ")) + theme.fg("accent", args.action) + theme.fg("dim", suffix);
  return new Text(text, 0, 0);
}

export function renderSchedulerResult({ details, isPartial, expanded, theme }: RenderSchedulerResultParams): Text {
  if (details.kind === "progress") {
    const icon = isPartial ? "◐" : "○";
    return new Text(
      `${theme.fg("warning", icon)} ${theme.fg("toolTitle", theme.bold("CREATE"))} ${theme.fg("accent", details.id)} ${theme.fg("muted", "— creating")}`,
      0,
      0
    );
  }
  if (details.kind === "remove") {
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("REMOVE"))} ${theme.fg("accent", details.id)} ${theme.fg("muted", "— removed")}`,
      0,
      0
    );
  }
  if (details.kind === "list") {
    const lines = [theme.fg("toolTitle", theme.bold(`scheduled tasks (${details.tasks.length})`))];
    for (const task of details.tasks) {
      lines.push(renderTaskLine(task, theme));
      if (expanded) {
        lines.push(theme.fg("muted", `  directory ${task.workingDirectory}`));
        if (task.startedAt) lines.push(theme.fg("muted", `  started ${task.startedAt}`));
        if (task.error) lines.push(theme.fg("error", `  ${task.error}`));
        if (task.resultPath) lines.push(theme.fg("dim", `  result ${task.resultPath}`));
      }
    }
    if (details.tasks.length === 0) lines.push(theme.fg("muted", "No scheduled tasks in this workspace."));
    return new Text(lines.join("\n"), 0, 0);
  }

  let presentation: StatusPresentation;
  if (isPartial) {
    presentation = { icon: "◐", color: "warning" };
  } else if (details.action === "create") {
    presentation = { icon: "✓", color: "success" };
  } else {
    presentation = getStatusPresentation(details.task.status);
  }
  const status = details.action === "create" && !isPartial ? `created · ${details.task.status}` : details.task.status;
  const lines = [
    `${theme.fg(presentation.color, presentation.icon)} ${theme.fg("toolTitle", theme.bold(details.action.toUpperCase()))} ${theme.fg("accent", details.task.id)} ${theme.fg("muted", `— ${status}`)}`,
    theme.fg("dim", `${details.task.schedule} · ${details.task.instructionsSummary}`)
  ];
  if (expanded) {
    lines.push(theme.fg("muted", `directory ${details.task.workingDirectory}`));
    lines.push(theme.fg("muted", `created ${details.task.createdAt}`));
    if (details.task.startedAt) lines.push(theme.fg("muted", `started ${details.task.startedAt}`));
    if (details.task.finishedAt) lines.push(theme.fg("muted", `finished ${details.task.finishedAt}`));
    if (details.task.error) lines.push(theme.fg("error", details.task.error));
    if (details.task.resultPath) lines.push(theme.fg("dim", `result ${details.task.resultPath}`));
    if (details.task.result) lines.push("", details.task.result);
  }
  return new Text(lines.join("\n"), 0, 0);
}
