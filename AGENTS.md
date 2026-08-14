# Project rules

## npm Registry publishing is forbidden

- Never publish this project to the npm Registry. Do not run `npm publish`.
- Keep `"private": true` in `package.json`; never remove or override this publication guard.
- Never add npm Registry credentials, tokens, `publishConfig`, or automated npm release workflows.
- npm, npx, `package.json`, lockfiles, and local package installation are allowed for development and use.
- Keep GitHub as the distribution source unless the user explicitly chooses another non-npm channel.
- If a future request would publish to the npm Registry, stop and explain the conflict. Only an explicit user instruction may change this rule.
