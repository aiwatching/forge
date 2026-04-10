# Usage Analytics

Forge tracks Claude API token usage and estimated costs across all your projects.

## Access

Click **Usage** in the Dashboard top navigation.

## Data Source

Forge scans these sources on-demand (via **Scan Now** button) or automatically on startup:

| Source | Location | What it tracks |
|---|---|---|
| `claude-code` | `~/.claude/projects/*/` | Interactive Claude Code sessions |
| `forge-task` | `~/.forge/data/tasks.db` | Background tasks submitted through Forge |
| `api-direct` | SDK/API calls logged by Forge | Direct API calls (rare) |

Stored in `~/.forge/data/usage.db` (SQLite). Each row records: session_id, source, project, model, day, input/output/cache tokens, cost_usd, message_count.

## Time Range Filter

Buttons in the header: **7d / 30d / 90d / All** — filter all charts and tables.

## Summary Cards

| Card | Shows |
|---|---|
| **Total Cost** | Sum of `cost_usd` in the selected range + trend (↑/↓ vs previous half) |
| **Daily Avg** | Total cost divided by days with activity |
| **Tokens** | Total tokens (input + output + cache read), broken down below |
| **Cache Hit** | `cacheRead / (input + cacheRead) × 100%` + cached tokens count |

## Visualizations

### Token Mix (stacked bar)
A single horizontal bar showing the proportion of:
- 🔵 Input tokens
- 🟢 Output tokens
- 🟣 Cache read tokens
- 🟠 Cache create tokens

Hover for tooltip.

### Cost Trend (line chart)
Line chart of daily cost over the selected range. Y-axis auto-scales to max cost. X-axis labels shown for ~7 date points.

### Activity Heatmap
GitHub-style 90-day grid: rows are weekdays (S/M/T/W/T/F/S), columns are weeks. Darker blue = higher cost. Hover a cell for exact date and cost.

### Avg by Weekday
Bar chart showing the average daily cost per weekday. Weekends highlighted in orange, weekdays in blue.

### By Model / By Source (donut charts)
Two side-by-side donut charts splitting total cost by model (Opus, Sonnet, Haiku) and by source (claude-code, forge-task, api-direct). Shows percentage + absolute cost per slice.

### By Project (bar list)
Top 20 projects ranked by cost. Each row shows project name, relative bar, cost, and session count.

### Model Details (table)
Per-model breakdown:
- Input / Output tokens
- Cost
- Message count
- Avg cost per message

### Summary Stats (bottom 3 cards)
- **Avg per session** — total cost / session count
- **Avg per message** — total cost / message count
- **Sessions per day** — session count / days with activity

## Cost Calculation

Estimates based on public Anthropic API pricing:

| Model | Input | Output |
|---|---|---|
| Claude Opus 4 | $15/M | $75/M |
| Claude Sonnet 4 | $3/M | $15/M |
| Claude Haiku 4 | ~$0.80/M | ~$4/M |

Cache reads are ~90% cheaper than regular inputs (~$0.30/M for Opus).

> Actual cost may differ if you're on Claude Max/Pro subscription (fixed monthly), or using Bedrock/Vertex with different pricing.

## Actions

- **Scan Now** — Re-scans all JSONL session files and tasks.db, updates the database
- **Time range** — 7/30/90/All days

## Troubleshooting

### Usage shows $0
- No data yet — click **Scan Now**
- Check `~/.claude/projects/` has JSONL session files
- Check `~/.forge/data/tasks.db` exists and has rows
- Check `~/.forge/data/usage.db` has data: `sqlite3 ~/.forge/data/usage.db 'SELECT COUNT(*) FROM token_usage'`

### Wrong project name
Usage scanner derives project name from directory path. Rename via scan refresh after moving projects.

### Missing recent sessions
Sessions in progress aren't tracked until the file is flushed. Click **Scan Now** to force a refresh.
