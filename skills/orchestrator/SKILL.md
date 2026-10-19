---
name: orchestrator
description: Split a large task between several agents running side by side in Herdr (Claude Code, Codex, opencode…), each picked for its role, then collect and check their results. Use when the user asks to dispatch, delegate or parallelize work across agents.
---

# Orchestrator

You coordinate other coding agents. Each one runs in its own Herdr pane next to yours, so the user can watch it live and answer its prompts from Huntaway.

## Requirements

Run `test "${HERDR_ENV:-}" = 1 && command -v huntawayd`. If it fails, say you are not running inside Herdr with Huntaway and do the work yourself.

## Plan first

1. Break the task into independent pieces that can run in parallel without editing the same files. Keep it to 2–4 agents.
2. Give each piece a role: `review`, `tests`, `ui`, `docs`, `refactor`, `research`… The user's `[routing]` table in `~/.config/huntaway/config.toml` maps roles to agents (for example `review = "codex"`); unknown roles use `default`, else Claude.
3. Tell the user the plan in a few lines before dispatching.

## Dispatch

Start each agent with a complete, self-contained task: it does not see this conversation. Name the files, the goal, the constraints and what to report back.

```bash
huntawayd dispatch --role review "Review the diff of the last commit in this repo. Report only actionable bugs with file:line. Do not edit files."
```

Useful options: `--kind codex|claude|opencode` (overrides the routing), `--name <name>`, `--model <model>`, `--cwd <dir>`. The command prints JSON with the agent `name`, `pane_id` and `agent_id`.

To wait for an agent and get its last message, add `--wait` (and `--timeout <seconds>`, default 1800). Dispatch the independent agents first without `--wait`, then wait for each one:

```bash
herdr agent wait <name> --timeout 1800000
herdr agent read <name> --source recent-unwrapped --lines 200
```

To give an agent a follow-up: `herdr agent prompt <name> "…" --wait`.

## While they work

- If `herdr agent get <name>` reports `blocked`, the agent is waiting for a permission or an answer. Do not answer it yourself: tell the user, who can answer from Huntaway or the pane.
- Do not edit the files an agent is working on.

## Finish

1. Read every agent's result. Check claims against the code (run the tests, read the diff) before reporting them.
2. Merge the results into one short report for the user: what was done, by whom, what is left.
3. Leave the panes open; the user closes them.
