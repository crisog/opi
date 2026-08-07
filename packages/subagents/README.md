# opi-subagents

Minimal subagents for Pi.

The package adds one `subagent` tool. It starts an isolated, ephemeral Pi process in the current working directory and returns its final response. The child inherits the parent's model and thinking level. Extensions are disabled in the child to prevent recursive delegation.

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

## Install

```sh
pi install /absolute/path/to/opi/packages/subagents
```
