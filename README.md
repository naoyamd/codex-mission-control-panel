# Codex Mission Control Panel

A dependency-free local dashboard for Codex tasks, agents, context, and usage.

Version 1.3 shows every task by default and uses a responsive overview layout:

- **Tasks:** live state, model, reasoning effort, remaining context, attention
  flags, pin priority, and nested subagents.
- **Navigation:** search by task, project, model, or effort; switch sort order;
  click a task card for a persistent minimal status and agent summary; and
  minimize or expand all cards at once.
- **Usage:** remaining Codex weekly capacity is the default view. Selected chat context
  and token activity live on a separate details screen; dedicated Spark limits
  stay out of the way.
- **Responsive:** a compact usage strip and multi-column task overview from
  720 px, with a single-column stacked view below that width.

> This is an independent community project, not an official OpenAI product.
> It uses the experimental Codex App Server interface described in the
> [official OpenAI documentation](https://developers.openai.com/codex/app-server/).

## Run

Requirements: Node.js 18+ and an authenticated `codex` CLI available on `PATH`.

```sh
npx --yes github:naoyamd/codex-mission-control-panel
```

Then open <http://127.0.0.1:43177/> in the Codex side panel or a browser.

To run from a clone:

```sh
npm start
```

Set a different port with `MISSION_CONTROL_PORT`.

```sh
MISSION_CONTROL_PORT=44000 npm start
```

PowerShell:

```powershell
$env:MISSION_CONTROL_PORT = 44000
npm start
```

## Check

```sh
npm run check
```

## Project policy

This project may use npm and npx locally, but it must never be published to the
npm Registry. `package.json` is marked `"private": true` to block accidental
publication. Distribution is currently through the public GitHub repository.

## Privacy and limits

- The HTTP server binds to `127.0.0.1` only.
- Task titles and project names stay on the local machine.
- Recent local Codex session metadata is read to supplement live status.
- Model and reasoning effort come from each session's latest recorded turn settings.
- Rate limits and token activity come from the authenticated Codex App Server.
- Token activity may be unavailable with API-key-only or Bedrock authentication.
- Completion percentages are not guessed; active work uses an indeterminate bar.
- The Codex App Server command and protocol may change while experimental.

## License

MIT
