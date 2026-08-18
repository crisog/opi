# opi-scheduler

Native recurring scheduled tasks for Pi.

The package adds one `scheduler` tool. Each task runs an isolated, non-interactive Pi process with self-contained instructions and explicit capabilities. Scheduled children do not load extensions, preventing recursive scheduler invocation. Tasks and their latest results are scoped to the workspace where they were created.

Supported platforms:

- macOS through a user LaunchAgent managed by `launchd`
- Linux through a systemd user service and timer

Other operating systems, macOS without an available user `launchd` domain, and Linux without an operational systemd user manager are unsupported. There is no cron fallback. Tasks use the current user's scheduler; on Linux, execution while logged out requires systemd user lingering to be enabled separately.

## Schedule format

Schedules use local system time and recur at one hour and minute. Weekdays use ISO numbering from Monday `1` through Sunday `7`. Omit `weekdays` to run daily.

```json
{
  "hour": 9,
  "minute": 0,
  "weekdays": [1, 2, 3, 4, 5]
}
```

## Try locally

```sh
pi -e ./packages/scheduler/src/index.ts
```

Then ask Pi:

```text
Every weekday at 9:00, inspect this repository for failing checks and explain what needs attention. Use read-only tools and bash.
```

The corresponding tool input is:

```json
{
  "action": "create",
  "id": "weekday-check",
  "instructions": "Inspect this repository for failing checks. Explain each failure and the next action. Do not modify files.",
  "schedule": {
    "hour": 9,
    "minute": 0,
    "weekdays": [1, 2, 3, 4, 5]
  },
  "tools": ["read", "grep", "find", "ls", "bash"],
  "skills": ["code-review"],
  "model": "openai-codex/gpt-5.6-luna",
  "thinkingLevel": "high"
}
```

`instructions`, `schedule`, and `id` are required when creating a task. The working directory is the Pi session's current directory. Model and thinking level inherit from the current session unless overridden. Tools default to `read`, `grep`, `find`, `ls`, and `bash`; `write` and `edit` must be granted explicitly. Skills must already be available to the current Pi session.

List tasks:

```json
{ "action": "list" }
```

Inspect the latest run and read its bounded result:

```json
{ "action": "status", "id": "weekday-check" }
```

Remove a task:

```json
{ "action": "remove", "id": "weekday-check" }
```

`list` shows the latest state for each task in the current workspace. `status` shows `never_run`, `running`, `completed`, or `failed`; completed results are bounded for model context and include the stable full-result path when truncated. The scheduler keeps one replaceable latest result plus stdout and stderr diagnostics per task.

The scheduler preserves the current `PATH` and Pi configuration directory for each native job. It does not persist API keys or other shell environment variables; configure provider authentication through Pi's `/login` flow or persistent provider configuration before scheduling a task.

## Install

```sh
pi install /absolute/path/to/opi/packages/scheduler
```
