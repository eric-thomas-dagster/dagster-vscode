# Dagster Power User

A standalone VS Code extension for [Dagster](https://dagster.io) development — no external backend required. Point it at a local project, a remote Dagster OSS deployment, or Dagster+, and get asset/dbt lineage, real diagnostics, an AI assistant grounded in your actual project, and run/schedule control, all from inside the editor.

## Features

### Project awareness
- Multi-root workspace support with `dg` CLI-based project detection (falls back to a heuristic scan for `dagster.yaml`/`pyproject.toml`).
- A sidebar tree (**Dagster Definitions**) of everything at the currently active target: assets, jobs, schedules, sensors, ops, resources, and IO managers. Follows whichever target is active (see below), not just your local project.
- Hover info and go-to-definition for asset/job/schedule/sensor references in Python and YAML.
- Real `dg check defs` diagnostics in the Problems panel — and if a project fails to load entirely (e.g. a real import error), that's surfaced explicitly instead of silently showing "0 definitions."
- The extension activates and its sidebar is usable even without a Dagster project open — everything that doesn't need local code (Dagster Expert chat, Dagster+ connection/usage, Remote/Dagster+ materialize/launch/runs) works regardless.

### Asset lineage
- A dedicated graph view of your project's asset DAG (dependencies, groups, kinds, staleness).

### Dagster Expert (AI assistant)
- A chat sidebar grounded in your project's real asset/job/schedule/sensor index — not generic Dagster trivia.
- Cites real `docs.dagster.io` pages via a live docs search.
- Session history: multiple named chats, archive/delete, switch via a QuickPick.
- **Ask Dagster Expert to fix this** — a Quick Fix code action on `dg check`/asset-reference diagnostics that proposes a real diff (preview before applying, never silently edits your files).
- Bring your own model: Anthropic or OpenAI, API key stored via VS Code's `SecretStorage` (never in settings).

### Local / Remote target switching
- Materialize assets and launch jobs against your **local** dev server, a **remote Dagster OSS** deployment (just a URL), or a **Dagster+** deployment — same two commands, different target, switchable from a segmented control at the top of the chat sidebar or via `Dagster: Switch Target`.
- Remote/Dagster+ targets go through the real `launchRun` GraphQL mutation directly — no local checkout required for those two.

### Schedules & sensors
- Start/stop schedules and sensors inline from the Dagster Definitions tree (same spot as the asset/job run buttons), or in bulk via `Dagster: Manage Schedules & Sensors` (includes a one-click "start everything that's stopped," handy right after a deploy where new schedules often come in paused).
- Works against local, remote OSS, or Dagster+ — same mutations, different endpoint.

### Run Explorer
- `Dagster: Show Runs` — a target-aware list of recent runs: status, job name, duration, inline log viewing, retry, and terminate.
- **Analyze Failure** — asks Dagster Expert to look at a failed run's real log output. If the traceback localizes to a file/line in your workspace, you get the same diff-preview Quick Fix flow as `dg check`; otherwise it's a regular chat conversation about the failure.
- "Open in Dagster" links (on runs and on assets in the tree) deep-link straight to the real run/asset page on whichever server you're targeting.

### Copilot Chat tools
- 9 VS Code Language Model Tools (list/materialize assets, list/launch jobs, list/get-logs/terminate/retry runs, list/toggle schedules & sensors) that GitHub Copilot Chat's agent mode can call directly — no `.vscode/mcp.json` or external server needed, and it works against whichever target (Local/Remote/Dagster+) is currently active.
- Side-effecting tools (materialize, launch, terminate, retry, toggle) require your confirmation before running, shown inline in the chat.

### Dagster+ integration
- `Dagster: Connect Dagster+...` stores your org + API token securely (token via `SecretStorage`, org slug as a plain setting).
- A compact credit-usage bar in the chat sidebar (nothing shown if you haven't connected — just a "Connect Dagster+" link), plus a full usage panel: current billing-period usage vs. limit (when your plan has one), a cumulative-usage sparkline, and a pace forecast for the current month.
- `Dagster: Set Up Dagster+ MCP Server` wires Dagster+'s own hosted MCP server into `.vscode/mcp.json`, so Claude Code/Cursor/Copilot Chat can query runs, assets, and deployments directly (OAuth handled by VS Code itself — no token to manage here).

### Component authoring
- Browse and install from the community component catalog.
- Scaffold a new Dagster project, or a GitHub Actions deploy workflow, from the command palette.

## Requirements

- A Python environment with `dagster`/`dg` installed for any project you want to detect locally (not required for remote-only / Dagster+-only use).
- An Anthropic or OpenAI API key for Dagster Expert (set via `Dagster: Set Anthropic API Key` / `Set OpenAI API Key`).

## Getting started

This extension isn't on the Marketplace yet — run it from source:

```bash
git clone https://github.com/eric-thomas-dagster/dagster-vscode.git
cd dagster-vscode
npm install
cd webview-ui && npm install && cd ..
npm run compile
```

Then open the folder in VS Code and press **F5** (Run Extension) to launch an Extension Development Host. Open a real Dagster project in that window to try it against your own code.

To build an installable `.vsix`:

```bash
npm run package
```

## Key commands

| Command | What it does |
|---|---|
| `Dagster: Show Asset Lineage` | Opens the asset dependency graph |
| `Dagster: Dev Server...` | Launch/manage a local `dg dev` instance |
| `Dagster: Materialize Asset...` / `Launch Job...` | Run against whichever target is active (Local/Remote/Dagster+) |
| `Dagster: Switch Target (Local / Remote)...` | Choose what Materialize/Launch/Manage Automations act on |
| `Dagster: Manage Schedules & Sensors` | Start/stop/bulk-start automations |
| `Dagster: Connect Dagster+...` | Store your Dagster+ org + API token |
| `Dagster: Show Dagster+ Usage` | Credit usage, limits, and forecast |
| `Dagster: Set Up Dagster+ MCP Server` | Wire Dagster+'s hosted MCP server into this workspace |
| `Dagster: Run dg check defs` | Validate definitions, surface errors in Problems |
| `Dagster: Ask Dagster Expert to Fix This` | Quick Fix lightbulb on a diagnostic |
| `Dagster: Show Runs` | Run Explorer — list, view logs, retry, terminate, analyze failures |
| `Dagster: More Actions...` | Everything else, grouped by category |

## Configuration

| Setting | Description |
|---|---|
| `dagsterPowerUser.dgPath` | Override the `dg` CLI path (defaults to resolving from PATH / the active Python interpreter) |
| `dagsterPowerUser.devServerUrl` | Override the local dev server's GraphQL endpoint (default `http://localhost:3000/graphql`) |
| `dagsterPowerUser.aiProvider` | `anthropic` (default) or `openai` |
| `dagsterPowerUser.aiModel` | Override the model id |
| `dagsterPowerUser.dagsterPlusOrg` | Your Dagster+ org slug (the API token is set separately, via `Connect Dagster+...`, and stored securely) |
| `dagsterPowerUser.dagsterPlusDeployment` | Default Dagster+ deployment to query (default `prod`) |

## Architecture

Two packages:
- **Extension host** (`src/`) — all `vscode.*` API usage and outbound GraphQL/CLI calls, esbuild-bundled to `dist/extension.js`. `src/data/activeTarget.ts` is the one place that resolves "Local/Remote/Dagster+" into an actual URL + auth headers; `src/lm/tools.ts` registers the Copilot Chat tools.
- **`webview-ui/`** — Vite + React, used only for the asset lineage graph (`dist/webview/`). The chat sidebar, Run Explorer, and Dagster+ usage panel are deliberately plain HTML/CSS/JS (`media/` and inline in `src/webviews/`), not React — simpler for what they need, and avoids extra build surface for views that are mostly text and buttons.

Every GraphQL field and CLI flag used here was verified against a real running `dg dev` instance (or a real Dagster+ org) before being written down — not guessed from documentation.

## License

Not yet specified.
