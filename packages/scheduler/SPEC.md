# Scheduler Specification

## Problem

The scheduler installs recurring Pi processes through launchd or systemd, but a completed run does not report a consumable result back through Pi. Scheduled children run with `--no-session`; stdout and stderr accumulate in log files; and the originating tool call only confirms that the native task was installed.

The current `notify` option says it creates a desktop notification, but it only enables an exit-code and timestamp file. With the default `notify: false`, even that last-run state is not recorded. `list` reads every globally stored task, returns log paths rather than results, and relies on Pi's generic tool renderer.

Users need a Pi-native way to see what a scheduled task last did without depending on the original session remaining open or manually reading append-only logs.

## Primary outcome

From any Pi session in the same workspace, a user can list scheduled tasks, see the latest run state, and open the latest bounded result through the `scheduler` tool with compact native TUI rendering.

Reporting is workspace-durable rather than tied to one transcript: the session that creates a schedule may be closed when the task fires.

## Smallest working proof

Reuse the existing schedule parser, task metadata, launchd/systemd installation, Pi invocation, trust decision, model and thinking inheritance, explicit tool grants, and external skill resolution.

Add one scheduler-owned run process invoked by the native service. It starts the isolated Pi child, owns that child handle, and atomically publishes the latest run record. No daemon or live session connection is introduced.

The scheduler store is partitioned by a stable hash of the canonical workspace path. Task IDs are unique within a workspace, and native launchd/systemd identifiers include the workspace key so equal task IDs from different workspaces do not collide.

Each task has one replaceable latest-run record with:

- `status`: `running`, `completed`, or `failed`;
- start and finish timestamps;
- a bounded error for failure;
- a stable full-result path for completion; and
- private stdout and stderr paths for diagnosis.

Run state is always recorded. Remove the current `notify` input because it does not implement its stated behavior; desktop notification is not required for this proof.

Keep `create`, `list`, and `remove`, and add `status`:

- `create` installs one workspace-scoped recurring task and returns its schedule and initial `never_run` state.
- `list` returns a bounded list for the current workspace with task ID, schedule, and latest state and timestamp.
- `status` requires an ID and returns task configuration plus the latest bounded result or failure. If the task has never run, it returns `never_run`.
- `remove` removes only the matching task and native unit in the current workspace.

Textual `content` and typed `details` remain the canonical interface for print, JSON, RPC, and TUI clients. Add pure `renderCall` and `renderResult` functions:

- calls show the action, shortened task instructions or ID, and schedule when present;
- partial creation shows a textual `creating` state;
- create and remove show explicit success states;
- list renders compact rows with ID, schedule, latest state, and timestamp;
- status renders `never_run`, `running`, `completed`, or `failed` textually, not by color alone; and
- expanded results may show the full instructions, tools, skills, model, thinking level, timestamps, error, and stable result and diagnostic paths already present in details.

The first end-to-end proof uses a deterministic local child:

1. Create the same task ID in two temporary canonical workspaces without collision.
2. Trigger one workspace's generated runner directly.
3. Observe `running` followed by an atomically written `completed` record and stable full result.
4. Read that result through a fresh scheduler store and the `status` action.
5. Confirm the other workspace cannot list, inspect, or remove it.
6. Render partial creation, bounded list, completed status, and failed status as deterministic TUI components.
7. Confirm launch failure, non-zero exit, malformed output, and missing final response publish `failed` rather than successful results.

Validation includes repository checks, deterministic tests without networked model calls, package dry-run inspection, and one real Pi smoke run outside the normal test suite.

## Known constraints

- macOS uses the current user's launchd domain; Linux uses systemd user services and timers. There is no cron fallback.
- Scheduled children remain non-interactive and use `--no-session`, `--no-extensions`, `--no-skills`, and `--no-prompt-templates`; explicitly requested external skills are loaded by resolved path.
- The current working directory, trust decision, model, thinking level, tools, and requested skills are captured when the task is created.
- Scheduler state lives under Pi's global agent directory, outside the repository, with user-only permissions.
- Stored metadata and child output are `unknown` until parsed at their boundaries.
- Model-visible list, status, error, and result output is bounded. Full artifacts remain at stable private paths.
- The scheduler runner owns terminal state transitions. Native unit files do not infer success from an unverified stale PID or partial record.
- Renderers derive display only from tool arguments and results. They do not poll the store or own background resources.

## Out of scope

- Appending results to or waking the exact Pi transcript that created the task
- A background daemon, socket service, or live-session IPC channel
- Automatic TUI polling while a session remains open
- Desktop, email, chat, or webhook notifications
- Per-run history beyond the latest durable run
- Retry policy, provider routing, quota management, or concurrency controls
- Write-capable safety changes beyond the scheduler's existing explicit tool grants
- Migration or automatic import of experimental globally scoped task state

## Later questions

- Add a workspace inbox or session-start widget for unseen completed and failed runs.
- Add bounded per-run history if the latest result is insufficient in practice.
- Add actual platform notifications as a separate delivery capability.
- Decide whether overlapping interval runs need admission control after native scheduler behavior is measured.
