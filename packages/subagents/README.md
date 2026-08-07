# opi-subagents

Minimal subagents for Pi.

The package adds one `subagent` tool. It starts an isolated, ephemeral Pi process in the current working directory and returns its final response. The child inherits the parent's model and thinking level. Extensions are disabled in the child to prevent recursive delegation.

## Try locally

```sh
pi -e ./packages/subagents/src/index.ts
```

Then ask Pi:

```text
Use a subagent to inspect this repository and identify the main entry points.
```

## Install

```sh
pi install /absolute/path/to/opi/packages/subagents
```
