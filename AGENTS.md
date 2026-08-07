# AGENTS.md

Guidance for coding agents working in this repository.

## Priorities

- Build the smallest complete solution that solves the current problem.
- Prefer explicit, readable code over cleverness or compressed syntax.
- Keep changes focused. Do not add speculative features, compatibility layers, or extension points.
- Follow local package conventions before introducing a new pattern.
- Fix the underlying problem rather than patching symptoms.

## Repository

- This is an npm workspace monorepo. Packages live under `packages/*`.
- Pi extensions are TypeScript source loaded directly by Pi; do not add a build step unless publishing requires one.
- Runtime dependencies belong in `dependencies`. Pi-provided packages belong in `peerDependencies` and development tooling in `devDependencies`.
- Keep package manifests publishable with an explicit `pi` resource manifest.
- Support Node.js 22 or newer.

## TypeScript

- Keep TypeScript strict with `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, and `noUnusedParameters`. Narrow before indexing arrays or records.
- Treat external data as `unknown` and narrow it at the boundary. Do not use `any` in application code.
- Do not use assertions to invent types. `as const` is allowed; avoid `as SomeType` and `as unknown as` outside test mocks. Prefer runtime checks or the package's existing schema library.
- Use `void` only as a return type, never as an operator. Await promises explicitly.
- Functions with more than one parameter take one object parameter. Define its named object type above the function; do not use inline object signatures.
- Use `type` consistently instead of `interface`.
- Put every field of an object type on its own line.
- Prefix boolean names with `is`, `has`, `should`, or `can`.
- Do not use TypeScript enums. Use `as const` values and derive the union type.
- Declare named constants at the top of the file in `UPPER_SNAKE_CASE`.
- Replace unexplained numeric limits with named constants and use separators in numeric literals greater than or equal to `1_000`.
- Prefer straightforward loops and conditionals over dense chains or nested ternaries.
- Use `undefined` for optional values and `null` only for a known absence.
- Use kebab-case file names and named exports, except where Pi requires a default extension factory.

## Error handling

- Throw when an operation cannot complete; do not encode failures as successful results.
- Catch errors only to add context, clean up, or deliberately degrade a non-critical operation. Never swallow errors.

## Abstraction

- Do not create pass-through wrappers, single-constant modules, or abstractions for hypothetical consumers.
- Keep a short operation inline when extracting it would make the signature larger than the implementation.
- Extract a helper only when it gives a concept a useful name, removes real duplication, or isolates a boundary.
- Match existing Pi APIs directly. Do not imitate another agent platform when Pi has a native convention.

## Comments and documentation

- Make code self-explanatory through naming and structure.
- Add a comment only when it records a constraint the code cannot express.
- Keep comments local and concise. Put design rationale in the PR description instead of a long code comment.
- Do not leave ticket references, review conversations, or temporary planning notes in source files.
- Update package documentation when installation or user-facing behavior changes.

## Pi extensions

- Read the installed Pi documentation and relevant examples before changing an extension API.
- Keep child processes isolated and abort-aware.
- Prevent accidental recursive extension loading unless recursion is an explicit feature.
- Respect project trust when forwarding project-local resources to child Pi processes.
- Bound all model-visible tool output. Preserve oversized output in a file and return its location.
- Surface child failures as failed tool executions with a useful error message.
- Preserve the parent's model and thinking level by default unless the public API explicitly allows overrides.

## Tests

- Test observable behavior, not constants, schemas, framework behavior, or implementation details.
- Cover the primary workflow and critical boundaries: child invocation, output parsing, cancellation, failure, and truncation when relevant.
- Add a regression test before fixing a reported bug.
- Keep tests inexpensive and deterministic. Use a real Pi smoke test when process integration changes, but do not make networked model calls part of the normal test suite.
- Do not add tests solely to increase coverage. Use coverage only to find important behavior that lacks protection.

## Validation

Run the repository checks before considering work complete:

```sh
npm run check
npm test
```

For a publishable package, also verify its contents:

```sh
npm pack --workspace=<workspace-name> --dry-run
```

## Workflow

- Never commit directly to `main`. Use a focused feature branch.
- Inspect the full diff before committing.
- Keep commits cohesive and use Conventional Commits.
- Keep changes in one PR when they share a root cause, fix pattern, or dependency. Split them when they have different root causes, risk profiles, or rollback needs.
- Do not push, publish, or create a PR unless the user asks.
- Resolve routine implementation details autonomously. Ask only when a decision changes product behavior or creates a meaningful tradeoff.
- Do not modify unrelated files or clean up code outside the task's scope.

## Communication

- Be brief and direct.
- Report what changed, how it was validated, and any remaining risk.
- Do not add a preamble, repeat the request, or present unnecessary option surveys.
