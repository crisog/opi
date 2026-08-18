import { readFile } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { StoredJob } from "./job-store.ts";

const MAX_LISTED_JOBS = 20;

type JobAction = "start" | "status" | "wait" | "cancel";

export type JobView = {
  id: string;
  status: StoredJob["kind"];
  taskSummary: string;
  createdAt: string;
  updatedAt: string;
  resultPath?: string;
  error?: string;
};

type JobDetails = {
  kind: "job";
  action: JobAction;
  job: JobView;
};

type JobListDetails = {
  kind: "list";
  action: "list";
  jobs: JobView[];
};

export type JobToolDetails = JobDetails | JobListDetails;

export type JobToolResult = {
  content: [{ type: "text"; text: string }];
  details: JobToolDetails;
};

type FormatJobResultParams = {
  action: JobAction;
  job: StoredJob;
};

function buildJobView(job: StoredJob): JobView {
  return {
    id: job.id,
    status: job.kind,
    taskSummary: job.taskSummary,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.kind === "completed" ? { resultPath: job.resultPath } : {}),
    ...(job.kind === "failed" ? { error: job.error } : {})
  };
}

function formatJobStatus(job: StoredJob): string {
  const heading = `Subagent job ${job.id}: ${job.kind}`;
  if (job.kind === "failed") return `${heading}\n${job.error}`;
  if (job.kind === "completed") return `${heading}\nFull result: ${job.resultPath}`;
  return heading;
}

async function formatCompletedOutput(job: Extract<StoredJob, { kind: "completed" }>): Promise<string> {
  const output = await readFile(job.resultPath, "utf8");
  const truncated = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES
  });
  if (!truncated.truncated) return output;
  return `${truncated.content}\n\n[Output truncated from ${formatSize(truncated.totalBytes)}. Full output: ${job.resultPath}]`;
}

export async function formatJobResult({ action, job }: FormatJobResultParams): Promise<JobToolResult> {
  let text = formatJobStatus(job);
  if (action === "wait" && job.kind === "completed") {
    text = `${text}\n\n${await formatCompletedOutput(job)}`;
  }

  return {
    content: [{ type: "text", text }],
    details: {
      kind: "job",
      action,
      job: buildJobView(job)
    }
  };
}

export function formatJobList(jobs: StoredJob[]): JobToolResult {
  const views = jobs.slice(0, MAX_LISTED_JOBS).map(buildJobView);
  const lines = views.map((job) => `${job.id} ${job.status} ${job.taskSummary}`);
  const text = lines.length > 0 ? lines.join("\n") : "No subagent jobs in this workspace.";
  return {
    content: [{ type: "text", text }],
    details: {
      kind: "list",
      action: "list",
      jobs: views
    }
  };
}
