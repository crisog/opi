# Subagents Specification

## Scope

`opi-subagents` provides focused Pi execution primitives. It owns child-process isolation, lifecycle state, bounded results, and native tool rendering. Workflow selection, orchestration, review loops, and other process policy belong to external skills rather than this package.

The package exposes two tools:

- `subagent` for synchronous tasks and committed-change reviews;
- `subagent_job` for durable, asynchronous read-only analysis.

## Shared child behavior

- Children use the current Pi runtime and run in the current workspace.
- The parent model and thinking level are inherited unless the tool call explicitly overrides them.
- Extensions are disabled to prevent recursive extension loading.
- Task text is passed through a protected file when it must not appear in process arguments.
- Child failures are surfaced with useful errors, and model-visible output is bounded.
- Oversized final output is preserved at a stable path returned with the truncated result.

## Synchronous subagent

### Task

The default `task` kind runs one isolated Pi child and returns its final response in the originating tool call.

- Project trust is forwarded to the child.
- A task may explicitly require skills already available in the parent Pi session.
- Requested skills are resolved to their existing paths and loaded directly; the package does not distribute skills.
- Cancellation terminates the child and fails the tool execution.

### Review

The `review` kind independently reviews committed changes from a required Git base.

- Review requires a trusted project and a clean working tree.
- The review scope is captured as an immutable patch between resolved base and head commits.
- The child has only Pi's `read`, `grep`, `find`, and `ls` tools; skills and prompt templates are disabled.
- The child returns a structured verdict: `approve`, `changes_requested`, or `review_failed`.
- Findings require a severity, location, and grounded claim.
- An approval cannot contain findings, and requested changes must contain at least one finding.
- The result is rejected if the head or worktree changes before the review completes.

## Durable subagent jobs

`subagent_job` uses an `action`-discriminated input:

- `start` requires a self-contained `task` and optionally accepts `model` and `thinkingLevel`.
- `status`, `wait`, and `cancel` require a generated `jobId`.
- `list` accepts no job-specific fields.

Durable jobs are read-only:

- Starting a job requires a trusted project.
- The child has only Pi's `read`, `grep`, `find`, and `ls` tools.
- Extensions, skills, and prompt templates are disabled.
- Detached write-capable tasks and asynchronous committed-change reviews are not supported.

### Lifecycle

Non-terminal states are `queued`, `running`, and `cancel_requested`. Terminal states are `completed`, `failed`, and `cancelled`.

- `start` durably creates the job, launches a detached worker, and returns the generated ID without waiting for model completion.
- `status` returns the current bounded job summary.
- `wait` polls until a terminal record exists and returns the same terminal result on repeated calls.
- Aborting `wait` stops only the wait call; it does not cancel the job.
- `cancel` writes a job-specific cancellation marker.
- The worker observes cancellation, terminates only the child process it owns, and records `cancelled`.
- `list` returns a bounded, most-recent-first view of jobs in the current workspace.

The worker owns the child handle and all terminal transitions. Cancellation never signals a PID recovered from persisted state.

### Persistence

- Jobs live under Pi's global agent directory rather than in the repository.
- The store is partitioned by a stable hash of the canonical workspace path.
- Job IDs cannot be read or cancelled from another workspace.
- Job directories use user-only permissions; task, state, stream, cancellation, and result files are private.
- Job records are parsed from `unknown`, checked at the storage boundary, and written atomically.
- Full child stdout and stderr remain private job artifacts and are never returned unbounded.

## Tool results and TUI

Textual `content` and typed `details` are the canonical interface for TUI, print, JSON, and RPC clients.

- Every action renders a compact action label and textual lifecycle state.
- `start` shows the shortened task and generated job ID.
- A partial `wait` result shows a loading indicator and current non-terminal state.
- `status` and `cancel` show the job ID and lifecycle state with theme-aware treatment.
- `list` shows shortened IDs, states, and task summaries in a compact task list.
- Expanded rendering may show full IDs, timestamps, error summaries, and stable result paths already present in details.
- Renderers are pure projections of tool arguments and results. They do not read the store or own background resources.

## Non-goals

- Bundled workflow skills or routing policy
- Fan-out, synthesis, retry, provider routing, or quota management
- Detached workspace mutation
- Cross-machine or cross-user jobs
- A broker, daemon, socket service, or compiled CLI
- Retention, garbage collection, notifications, or scheduler integration
- Persistent widgets, editor replacement, or an interactive task-manager overlay
