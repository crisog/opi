# opi-subagents

Focused subagent capabilities for Pi.

The package adds two tools:

- `subagent` starts an isolated, ephemeral Pi process and returns its final response in the same tool call.
- `subagent_job` starts and manages durable, read-only analysis jobs that continue independently of the originating tool call.

Both use the current Pi runtime and inherit the parent's model and thinking level unless explicitly overridden. Extensions are disabled in children to prevent recursive delegation. OPI provides execution capabilities only; it does not package workflow skills.

The canonical behavioral contract for both tools is [the subagents specification](../../docs/subagents.spec.md).

The default `task` kind handles focused research and investigation. It can require named skills that are available in the parent Pi session; the child loads those skill paths explicitly and is instructed to follow them before starting. Task and review children inherit the parent's model and thinking level unless the tool call explicitly overrides either one. The `review` kind reviews committed branch changes from a required Git base ref. Reviews require a trusted project and clean working tree, run with only Pi's read-only tools and no skills, validate a structured fail-closed verdict, and reject results that become stale before completion.

## Try locally

```sh
pi -e ./packages/subagents/src/index.ts
```

Then ask Pi:

```text
Use a subagent to inspect this repository and identify the main entry points.
```

To require a skill, ask Pi to pass its name without the `skill:` prefix:

```text
Use a task subagent with the planout skill to create an implementation plan from docs/spec.md.
```

The corresponding tool input is:

```json
{
  "kind": "task",
  "skills": ["planout"],
  "task": "Create an implementation plan from docs/spec.md."
}
```

To override the inherited model or thinking level for either kind:

```json
{
  "kind": "task",
  "model": "openai-codex/gpt-5.6-luna",
  "thinkingLevel": "high",
  "task": "Inspect the authentication flow for concurrency risks."
}
```

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Model values use Pi's normal model pattern or `provider/model` format.

For an independent review:

```text
Use a review subagent with base origin/main to review the committed branch changes against their documented behavior.
```

## Durable jobs

Durable jobs require a trusted project and can only use Pi's `read`, `grep`, `find`, and `ls` tools. Skills, prompt templates, and extensions are disabled. Job state and full results are stored privately under Pi's global agent directory, partitioned by canonical workspace path.

Start a job:

```json
{
  "action": "start",
  "task": "Inspect the authentication boundary and report concrete risks."
}
```

The result includes a job ID immediately. Use that ID from the same or a later Pi session in the workspace:

```json
{ "action": "status", "jobId": "..." }
{ "action": "wait", "jobId": "..." }
{ "action": "cancel", "jobId": "..." }
```

List recent jobs with `{ "action": "list" }`. Aborting a `wait` call leaves the detached job running; `cancel` explicitly asks the worker that owns the child process to terminate it. Pi's TUI shows compact lifecycle and task-list renderings, while print, JSON, and RPC modes receive the same canonical text and structured details.

## Install

```sh
pi install /absolute/path/to/opi/packages/subagents
```
