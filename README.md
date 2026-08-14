# Codex Mission Control Panel

A tiny, dependency-free local dashboard for Codex task and subagent status.

It shows active tasks, tasks needing attention, parent/subagent relationships,
and live status updates in a narrow layout suited to the Codex side panel.

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

## Privacy and limits

- The HTTP server binds to `127.0.0.1` only.
- Task titles and project names stay on the local machine.
- Recent local Codex session metadata is read to supplement live status.
- Completion percentages are not guessed; active work uses an indeterminate bar.
- The Codex App Server command and protocol may change while experimental.

## License

MIT
