# opi

**o(verpowered)pi**

A monorepo for building an overpowered pi.

## Development

Use the pinned Node.js and npm versions, then install dependencies:

```sh
nvm install
npm install --global npm@12.0.2
npm ci
```

Workspace packages live under `packages/*`.

Run the quality checks and tests:

```sh
npm run check
npm test
```

Husky runs lint-staged checks before each commit.

## Dependency security

npm rejects unreviewed install scripts, newly published releases, and non-registry transitive dependencies. Review dependency scripts explicitly when an install reports one:

```sh
npm install-scripts ls
npm install-scripts approve <package>
npm install-scripts deny <package>
```

CI verifies registry signatures and provenance attestations with `npm audit signatures`.
