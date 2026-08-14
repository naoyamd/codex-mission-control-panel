# Project rules

## Forbidden package tooling

- Never use npm, npx, pnpm, Yarn, Bun, package registries, `package.json`, lockfiles, or `node_modules` in this project.
- Keep the project dependency-free. Use only the Node.js standard library and the existing `codex` CLI.
- Run the app with `node server.mjs`.
- Verify it with `node --check server.mjs` and `node server.mjs --self-check`.
- If a future request appears to require a package or package manager, stop and explain the conflict instead of adding one. Only an explicit user instruction may change this rule.
