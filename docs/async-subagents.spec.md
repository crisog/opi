# Asynchronous Subagent Jobs Specification

Status: Implemented

## Problem

`opi-subagents` currently waits inside one `subagent` tool call until its child Pi process finishes. The caller cannot start work, continue using the parent session, and later inspect, wait for, or cancel that work. The result and process lifetime are therefore tied to the originating tool call.

OPI needs a durable execution primitive that external workflow skills can compose without bundling those skills into OPI. The first version must not allow a detached worker to modify a shared worktree after the originating session has moved on.

The lifecycle must also be legible in Pi's interactive interface. Raw job JSON is an acceptable machine contract but not an adequate user experience for starting work, waiting on a child, or scanning a task list.

## Primary outcome

A trusted Pi session can start a durable, read-only analysis subagent, receive a job ID immediately, and use that ID from later tool calls or sessions in the same workspace to inspect, wait for, or request cancellation of the job, with compact native TUI rendering for each lifecycle action.

## Smallest working proof

Add a second tool named `subagent_job` to `opi-subagents`. Keep the existing synchronous `subagent` tool and its task and review behavior unchanged.

`subagent_job` accepts a discriminated union keyed by `action`:

- `start` requires a self-contained `task` and optionally accepts `model` and `thinkingLevel`.
- `status`, `wait`, and `cancel` require a generated `jobId`.
- `list` accepts no job-specific fields.

The first implementation supports read-only analysis jobs only:

- The child runs with extensions, skills, and prompt templates disabled.
- The child receives only Pi's `read`, `grep`, `find`, and `ls` tools.
- Starting a job requires a trusted project.
- The job captures the current workspace, model, and thinking level when it starts.
- The task is written to a mode-`0600` file and passed by path rather than as a command-line argument.

`start` creates a workspace-scoped job directory under Pi's global agent directory, launches a detached OPI worker process, and returns after the worker has been spawned and the job record has been durably written. It returns a generated job ID and the initial status without waiting for model completion.

The worker owns the child Pi process and all terminal state transitions. It writes job state atomically and records exactly one terminal status:

- `completed` with the final assistant response;
- `failed` with a useful bounded error; or
- `cancelled` after a cancellation request terminates the child.

Non-terminal statuses are `queued`, `running`, and `cancel_requested`.

The lifecycle actions behave as follows:

1. `status` returns the current bounded job summary.
2. `wait` waits for a terminal record and returns the same terminal result that future `wait` calls return. Cancelling the `wait` tool call stops waiting but does not cancel the job.
3. `cancel` writes a job-specific cancellation request. The worker observes that request, terminates only the child process it owns, and publishes `cancelled`. Cancellation must not signal a PID read from an unverified stale record.
4. `list` returns a bounded most-recent-first summary of jobs belonging to the current workspace.

`subagent_job` provides custom `renderCall` and `renderResult` implementations for Pi's interactive TUI:

- Every action renders a compact action label and textual status; status must not be communicated by color alone.
- `start` renders the shortened task and the generated job ID without dumping the full task or raw job record.
- `wait` renders a Pi-native loading indicator while the result is partial, then replaces it with the terminal status and bounded result summary.
- `status` and `cancel` render the job ID and current lifecycle status with theme-aware success, warning, or error treatment.
- `list` renders a compact task list with one row per bounded result, including shortened job ID, status, and task summary. Expanded rendering may show the full IDs, timestamps, error summary, and stable result path already present in the tool result.
- Renderers derive their display only from tool arguments, partial updates, and final tool results. They do not read the job store, start background resources, or become required for lifecycle correctness.

The tool's textual `content` and typed `details` remain the canonical interface in print, JSON, RPC clients without TUI support, and when a custom renderer fails. TUI rendering must not change, hide, or reclassify terminal job state.

The job store is outside the repository so creating a job does not dirty the reviewed worktree. Jobs are partitioned by a stable key derived from the canonical workspace path; a job ID from another workspace is not readable or cancellable. Task text, full output, and process metadata are private user data and must be created with user-only filesystem permissions.

Model-visible output remains bounded. A completed job returns truncated output when necessary and provides the stable full-output path inside its job directory. Repeated `status`, `wait`, and `list` calls must not expose raw unbounded stdout, stderr, or event streams.

The proof is complete when deterministic tests demonstrate that:

- `start` returns before a controlled child finishes;
- a job proceeds from `queued` or `running` to `completed` and can be retrieved by a later `wait` call;
- child launch failure, non-zero exit, malformed output, and missing final output become `failed` rather than successful results;
- `cancel` causes the owned controlled child to terminate and the job to become `cancelled`;
- cancelling `wait` leaves the underlying job running;
- oversized output is bounded in the tool response and preserved at the reported path;
- jobs are isolated by canonical workspace and `list` is bounded;
- partial `wait`, completed, failed, cancelled, and list results render as compact deterministic TUI components with textual status labels; and
- the existing synchronous task and review tests remain unchanged and passing.

Validation must include `npm run check`, `npm test`, and `npm pack --workspace=opi-subagents --dry-run`. Process integration tests must use a deterministic local child and make no networked model calls. Validation must also include one real Pi smoke run outside the normal test suite because the child-process integration changes.

## Known constraints

- OPI owns tools and execution capabilities. Workflow skills remain in the external skills repository and are not packaged by OPI.
- The implementation must reuse the existing Pi invocation, model/thinking inheritance, protected prompt-file, JSON event parsing, failure interpretation, and output truncation behavior where their contracts match.
- A detached child must not load OPI extensions recursively.
- Background resources must start from the tool action, not the extension factory. The detached job must not depend on in-memory extension state or a `session_shutdown` handler to finish.
- Cancellation must be job-owned and process-safe. A stored numeric PID alone is not sufficient authority to signal a process.
- Job records and terminal results must be written atomically so later sessions never consume partial JSON.
- External data read from job files or child output is `unknown` until parsed at its boundary.
- All tool variants must be represented by one `action`-discriminated union rather than optional fields with scattered validation.
- The implementation must preserve bounded model-visible output and surface child failures as failed tool results.
- Custom renderers must use Pi's theme and component APIs, support partial and expanded states, remain compact by default, and preserve the default textual fallback.

## Out of scope

- Detached write-capable subagents or any background process allowed to modify the workspace.
- Asynchronous independent review; the existing SHA and worktree-staleness checks remain synchronous.
- Bundled OPI skills, workflow routing, review loops, automatic fix-up, fan-out, synthesis, or orchestration.
- A broker, socket service, daemon, hook system, or compiled OPI CLI.
- Cross-machine or cross-user jobs.
- Automatic retry, provider routing, quota management, scheduling integration, notifications, retention, garbage collection, or manual job deletion.
- Persistent job widgets, footer replacement, custom editor replacement, transcript cards, and an interactive task-manager overlay or `/subagents` command.
- Changing the existing `subagent` tool schema or behavior.

## Later questions

- Add retention and explicit cleanup after real job volume establishes an appropriate policy.
- Decide whether async review can preserve immutable scope and stale-verdict guarantees without duplicating the synchronous review path.
- Add write-capable jobs only with explicit write scope and isolated worktrees.
- Decide whether concurrency limits or per-workspace admission control are needed.
- Add fan-out or orchestration only after the durable single-job primitive is proven.
- Decide whether scheduler jobs should consume completed subagent results or remain independent.
- Decide whether active-job counts, a persistent widget, completion notifications, or an interactive `/subagents` overlay provide enough value to justify session-scoped UI state.
