# Benchmark: Claude Code vs Forge Workspace

Compares a single Claude Code run against a Forge multi-smith workspace on the same task.

## Files

- `task.md` — task description (given to both harnesses verbatim)
- `validator.sh` — validates the output (exit 0 = pass)
- `run.ts` — main runner
- `results/` — markdown reports (gitignored)

## Prerequisites

1. **Forge running**: `forge server start` (listening on port 8403)
2. **Claude Code installed** and authenticated (`claude --version` works)
3. **harness_test project** exists at `/Users/zliu/IdeaProjects/harness_test`

## Run

```bash
pnpm tsx scripts/bench/run.ts
```

## What it does

1. Prepares `bench/start` branch in harness_test (fresh from main)
2. **Claude Code run**:
   - Creates `bench/claude-<ts>` branch
   - Runs `claude -p --dangerously-skip-permissions "<task>"` in harness_test
   - Commits output, runs validator
3. **Forge workspace run**:
   - Creates `bench/forge-<ts>` branch
   - Finds/creates workspace pointing at harness_test
   - Removes existing agents, adds fresh Input → Lead → Engineer → QA
   - Starts daemon, submits task to Input, triggers Lead
   - Polls every 10s until all smiths finish (or 20min timeout)
   - Stops daemon, commits output, runs validator
4. Writes comparison report to `results/report-<ts>.md`

## Validation

The validator checks:
1. `src/utils/text.js` exists with `capitalize` and `reverseWords` exports
2. `src/utils/text.test.js` exists
3. `node --test utils/text.test.js` passes (agent's own tests)
4. External smoke test: independent check that both functions behave correctly (including error cases)

## Inspecting Results

- Git branches: `git branch | grep bench/` in harness_test
- Diff: `git diff bench/start...bench/claude-<ts>` (or `forge-<ts>`)
- Markdown report: `scripts/bench/results/report-<ts>.md`

## Tuning

Edit `run.ts` constants:
- `TASK_TIMEOUT_MS` — per-run timeout (default 20 min)
- `POLL_INTERVAL_MS` — Forge polling frequency (default 10s)
- `PROJECT` — target project path
- `FORGE_URL` — Forge API base URL

## Notes

- The script leaves branches around for inspection — you can diff them manually after
- Forge workspace agents are configured minimally (role + 2-3 steps each) to keep comparison fair
- If Forge has auth enabled, the script may need a token — extend `api()` helper to send `X-Forge-Token`
