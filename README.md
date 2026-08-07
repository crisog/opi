# opi

**o(verpowered)pi**

A monorepo for building an overpowered pi.

## Development

Use the pinned Node.js version and install dependencies:

```sh
nvm install
npm install
```

Workspace packages live under `packages/*`.

Run the quality checks and tests:

```sh
npm run check
npm test
```

Husky runs lint-staged checks before each commit.
