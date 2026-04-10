'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';

interface UsageData {
  total: { input: number; output: number; cacheRead: number; cacheCreate: number; cost: number; sessions: number; messages: number };
  byProject: { name: string; input: number; output: number; cost: number; sessions: number }[];
  byModel: { model: string; input: number; output: number; cost: number; messages: number }[];
  byDay: { date: string; input: number; output: number; cacheRead: number; cacheCreate: number; cost: number; messages: number }[];
  bySource: { source: string; input: number; output: number; cost: number; messages: number }[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

// ─── Horizontal bar ──────────────────────────────────────

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden flex-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Stacked bar for tokens breakdown ─────────────────────

function StackedBar({ input, output, cacheRead, cacheCreate }: { input: number; output: number; cacheRead: number; cacheCreate: number }) {
  const total = input + output + cacheRead + cacheCreate;
  if (total === 0) return <div className="h-2 bg-[var(--bg-tertiary)] rounded-full" />;
  const inputPct = (input / total) * 100;
  const outputPct = (output / total) * 100;
  const cacheReadPct = (cacheRead / total) * 100;
  const cacheCreatePct = (cacheCreate / total) * 100;
  return (
    <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden flex">
      <div className="h-full bg-blue-500" style={{ width: `${inputPct}%` }} title={`Input: ${formatTokens(input)}`} />
      <div className="h-full bg-green-500" style={{ width: `${outputPct}%` }} title={`Output: ${formatTokens(output)}`} />
      <div className="h-full bg-purple-500" style={{ width: `${cacheReadPct}%` }} title={`Cache read: ${formatTokens(cacheRead)}`} />
      <div className="h-full bg-orange-500" style={{ width: `${cacheCreatePct}%` }} title={`Cache create: ${formatTokens(cacheCreate)}`} />
    </div>
  );
}

// ─── Pie/donut chart using SVG ─────────────────────────────

interface PieSlice { label: string; value: number; color: string }

function DonutChart({ data, size = 140 }: { data: PieSlice[]; size?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <div className="text-[10px] text-[var(--text-secondary)]">No data</div>;

  const radius = size / 2 - 4;
  const innerRadius = radius * 0.6;
  const cx = size / 2, cy = size / 2;

  let startAngle = -Math.PI / 2; // start at top
  const slices = data.map(slice => {
    const fraction = slice.value / total;
    const endAngle = startAngle + fraction * 2 * Math.PI;
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const x3 = cx + innerRadius * Math.cos(endAngle);
    const y3 = cy + innerRadius * Math.sin(endAngle);
    const x4 = cx + innerRadius * Math.cos(startAngle);
    const y4 = cy + innerRadius * Math.sin(startAngle);
    const largeArc = fraction > 0.5 ? 1 : 0;
    const d = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`;
    startAngle = endAngle;
    return { d, color: slice.color, label: slice.label, value: slice.value, pct: fraction * 100 };
  });

  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {slices.map((s, i) => (
          <path key={i} d={s.d} fill={s.color}>
            <title>{`${s.label}: ${formatCost(s.value)} (${s.pct.toFixed(1)}%)`}</title>
          </path>
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" className="fill-[var(--text-primary)] text-[11px] font-bold">
          {formatCost(total)}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" className="fill-[var(--text-secondary)] text-[8px]">
          total
        </text>
      </svg>
      <div className="flex-1 space-y-1">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[10px]">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
            <span className="text-[var(--text-primary)] truncate flex-1">{s.label}</span>
            <span className="text-[var(--text-secondary)] text-[9px] w-10 text-right">{s.pct.toFixed(1)}%</span>
            <span className="text-[var(--text-primary)] w-12 text-right font-mono">{formatCost(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Line chart for trends ────────────────────────────────

function LineChart({ data, width = 520, height = 80 }: { data: { date: string; cost: number; messages: number }[]; width?: number; height?: number }) {
  if (data.length === 0) return <div className="text-[10px] text-[var(--text-secondary)] py-6 text-center">No data</div>;

  // Reverse so earliest is on left
  const points = [...data].reverse();
  const padding = { top: 10, right: 10, bottom: 22, left: 40 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxCost = Math.max(...points.map(p => p.cost), 0.001);
  const maxMsgs = Math.max(...points.map(p => p.messages), 1);

  const xStep = points.length > 1 ? chartW / (points.length - 1) : 0;
  const pathCost = points.map((p, i) => {
    const x = padding.left + i * xStep;
    const y = padding.top + chartH - (p.cost / maxCost) * chartH;
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  const areaCost = pathCost + ` L ${padding.left + (points.length - 1) * xStep} ${padding.top + chartH} L ${padding.left} ${padding.top + chartH} Z`;

  // Y axis ticks (0, 50%, 100%)
  const yTicks = [0, 0.5, 1];

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
      {/* Grid lines */}
      {yTicks.map((t, i) => {
        const y = padding.top + chartH * (1 - t);
        return (
          <g key={i}>
            <line x1={padding.left} y1={y} x2={padding.left + chartW} y2={y}
              stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2 2" />
            <text x={padding.left - 4} y={y + 3} textAnchor="end" className="fill-[var(--text-secondary)] text-[8px]">
              {formatCost(maxCost * t)}
            </text>
          </g>
        );
      })}

      {/* Area fill */}
      <path d={areaCost} fill="var(--accent)" opacity="0.15" />
      {/* Line */}
      <path d={pathCost} fill="none" stroke="var(--accent)" strokeWidth="1.5" />

      {/* Points + labels (only a few to avoid overlap) */}
      {points.map((p, i) => {
        const x = padding.left + i * xStep;
        const y = padding.top + chartH - (p.cost / maxCost) * chartH;
        const showLabel = points.length <= 10 || i % Math.ceil(points.length / 7) === 0 || i === points.length - 1;
        return (
          <g key={p.date}>
            <circle cx={x} cy={y} r="2" fill="var(--accent)" stroke="var(--bg-primary)" strokeWidth="0.5" />
            {showLabel && (
              <text x={x} y={height - 6} textAnchor="middle" className="fill-[var(--text-secondary)] text-[8px]">
                {p.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Heatmap by day (grid) ────────────────────────────────

function Heatmap({ data, days: numDays = 90 }: { data: { date: string; cost: number }[]; days?: number }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map(d => d.cost), 0.01);

  const costMap = new Map(data.map(d => [d.date, d.cost]));

  // Build last N days
  const days: { date: string; cost: number; dow: number }[] = [];
  const today = new Date();
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date: dateStr, cost: costMap.get(dateStr) || 0, dow: d.getDay() });
  }

  const intensity = (c: number) => {
    if (c === 0) return 0;
    return Math.min(4, Math.ceil((c / max) * 4));
  };

  const bgClasses = [
    'bg-[var(--bg-tertiary)]',
    'bg-blue-900/40',
    'bg-blue-700/60',
    'bg-blue-500/80',
    'bg-blue-400',
  ];

  // Organize by week (columns) × weekday (rows), GitHub-style
  // Start with padding for the first week
  const firstDow = days[0].dow;
  const weeks: (typeof days[0] | null)[][] = [];
  let currentWeek: (typeof days[0] | null)[] = Array(firstDow).fill(null);
  for (const d of days) {
    currentWeek.push(d);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <div className="flex gap-1">
      {/* Weekday labels */}
      <div className="flex flex-col gap-[2px] pt-0.5">
        {dayLabels.map((l, i) => (
          <div key={i} className="text-[7px] text-[var(--text-secondary)] h-[11px] leading-[11px]">
            {i % 2 === 1 ? l : ''}
          </div>
        ))}
      </div>
      {/* Week columns */}
      <div className="flex gap-[2px] overflow-x-auto">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[2px]">
            {week.map((day, di) => (
              day ? (
                <div
                  key={di}
                  className={`w-[11px] h-[11px] rounded-sm ${bgClasses[intensity(day.cost)]}`}
                  title={`${day.date}: ${formatCost(day.cost)}`}
                />
              ) : (
                <div key={di} className="w-[11px] h-[11px]" />
              )
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Weekday cost distribution ──────────────────────────

function WeekdayChart({ data }: { data: { date: string; cost: number }[] }) {
  if (data.length === 0) return null;
  const byDow: number[] = Array(7).fill(0);
  const countByDow: number[] = Array(7).fill(0);
  for (const d of data) {
    const date = new Date(d.date);
    const dow = date.getDay();
    byDow[dow] += d.cost;
    countByDow[dow]++;
  }
  const avgByDow = byDow.map((sum, i) => countByDow[i] > 0 ? sum / countByDow[i] : 0);
  const max = Math.max(...avgByDow, 0.01);
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="flex items-end gap-1 h-16">
      {avgByDow.map((v, i) => {
        const pct = (v / max) * 100;
        const isWeekend = i === 0 || i === 6;
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
            <div className="w-full flex-1 flex items-end">
              <div
                className={`w-full rounded-t ${isWeekend ? 'bg-orange-500/60' : 'bg-blue-500/60'}`}
                style={{ height: `${Math.max(pct, 2)}%` }}
                title={`${labels[i]}: ${formatCost(v)} avg`}
              />
            </div>
            <div className="text-[8px] text-[var(--text-secondary)]">{labels[i][0]}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────

const MODEL_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export default function UsagePanel() {
  const [data, setData] = useState<UsageData | null>(null);
  const [days, setDays] = useState(7);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage${days ? `?days=${days}` : ''}`);
      const d = await res.json();
      setData(d);
    } catch {}
    setLoading(false);
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const triggerScan = async () => {
    setScanning(true);
    try {
      await fetch('/api/usage', { method: 'POST' });
      await fetchData();
    } catch {}
    setScanning(false);
  };

  // Calculate averages and trends
  const stats = useMemo(() => {
    if (!data) return null;
    const byDay = data.byDay;
    const avgDaily = byDay.length > 0 ? data.total.cost / byDay.length : 0;
    const avgPerSession = data.total.sessions > 0 ? data.total.cost / data.total.sessions : 0;
    const avgPerMsg = data.total.messages > 0 ? data.total.cost / data.total.messages : 0;

    // Trend: compare last half vs first half
    let trend = 0;
    if (byDay.length >= 4) {
      const mid = Math.floor(byDay.length / 2);
      const recent = byDay.slice(0, mid).reduce((s, d) => s + d.cost, 0);
      const earlier = byDay.slice(mid).reduce((s, d) => s + d.cost, 0);
      trend = earlier > 0 ? ((recent - earlier) / earlier) * 100 : 0;
    }

    // Cache efficiency
    const totalInput = data.total.input + data.total.cacheRead;
    const cacheHitRate = totalInput > 0 ? (data.total.cacheRead / totalInput) * 100 : 0;

    return { avgDaily, avgPerSession, avgPerMsg, trend, cacheHitRate };
  }, [data]);

  if (loading && !data) {
    return <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)] text-xs">Loading usage data...</div>;
  }

  if (!data || !stats) {
    return <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)] text-xs">Failed to load usage data</div>;
  }

  const maxProjectCost = data.byProject.length > 0 ? data.byProject[0].cost : 1;

  // Prepare pie chart data
  const modelPie: PieSlice[] = data.byModel.slice(0, 6).map((m, i) => ({
    label: m.model.replace('claude-', ''),
    value: m.cost,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }));
  const sourcePie: PieSlice[] = data.bySource.slice(0, 6).map((s, i) => ({
    label: s.source,
    value: s.cost,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }));

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)] shrink-0 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Token Usage</h2>
        <div className="flex items-center gap-1 ml-auto">
          {[7, 30, 90, 0].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-[10px] px-2 py-0.5 rounded ${days === d ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              {d === 0 ? 'All' : `${d}d`}
            </button>
          ))}
        </div>
        <button
          onClick={triggerScan}
          disabled={scanning}
          className="text-[10px] px-2 py-0.5 border border-[var(--border)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          {scanning ? 'Scanning...' : 'Scan Now'}
        </button>
      </div>

      <div className="p-4 space-y-5">
        {/* ─── Summary cards ──────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
            <div className="text-[9px] text-[var(--text-secondary)] uppercase">Total Cost</div>
            <div className="text-lg font-bold text-[var(--text-primary)]">{formatCost(data.total.cost)}</div>
            {stats.trend !== 0 && (
              <div className={`text-[9px] ${stats.trend > 0 ? 'text-red-400' : 'text-green-400'}`}>
                {stats.trend > 0 ? '↑' : '↓'} {Math.abs(stats.trend).toFixed(0)}% vs prev period
              </div>
            )}
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
            <div className="text-[9px] text-[var(--text-secondary)] uppercase">Daily Avg</div>
            <div className="text-lg font-bold text-[var(--text-primary)]">{formatCost(stats.avgDaily)}</div>
            <div className="text-[9px] text-[var(--text-secondary)]">per day</div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
            <div className="text-[9px] text-[var(--text-secondary)] uppercase">Tokens</div>
            <div className="text-lg font-bold text-[var(--text-primary)]">{formatTokens(data.total.input + data.total.output + data.total.cacheRead)}</div>
            <div className="text-[9px] text-[var(--text-secondary)]">
              {formatTokens(data.total.input)} in · {formatTokens(data.total.output)} out
            </div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
            <div className="text-[9px] text-[var(--text-secondary)] uppercase">Cache Hit</div>
            <div className="text-lg font-bold text-[var(--text-primary)]">{stats.cacheHitRate.toFixed(0)}%</div>
            <div className="text-[9px] text-[var(--text-secondary)]">{formatTokens(data.total.cacheRead)} cached</div>
          </div>
        </div>

        {/* ─── Token breakdown stacked bar ──────────────── */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase">Token Mix</h3>
            <div className="flex items-center gap-3 text-[9px]">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500"></span>Input</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500"></span>Output</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-purple-500"></span>Cache R</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-orange-500"></span>Cache W</span>
            </div>
          </div>
          <StackedBar
            input={data.total.input}
            output={data.total.output}
            cacheRead={data.total.cacheRead}
            cacheCreate={data.total.cacheCreate}
          />
        </div>

        {/* ─── Daily trend line chart ───────────────────── */}
        {data.byDay.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase mb-2">Cost Trend</h3>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
              <LineChart data={data.byDay} />
            </div>
          </div>
        )}

        {/* ─── Activity heatmap (90 days) + weekday ─────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase">Activity (last 90 days)</h3>
              <div className="flex items-center gap-1 text-[8px] text-[var(--text-secondary)]">
                <span>less</span>
                <span className="w-2 h-2 rounded-sm bg-[var(--bg-tertiary)]"></span>
                <span className="w-2 h-2 rounded-sm bg-blue-900/40"></span>
                <span className="w-2 h-2 rounded-sm bg-blue-700/60"></span>
                <span className="w-2 h-2 rounded-sm bg-blue-500/80"></span>
                <span className="w-2 h-2 rounded-sm bg-blue-400"></span>
                <span>more</span>
              </div>
            </div>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
              <Heatmap data={data.byDay} days={91} />
            </div>
          </div>
          <div>
            <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase mb-2">Avg by Weekday</h3>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
              <WeekdayChart data={data.byDay} />
            </div>
          </div>
        </div>

        {/* ─── Pie charts row ───────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {modelPie.length > 0 && (
            <div>
              <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase mb-2">By Model</h3>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
                <DonutChart data={modelPie} />
              </div>
            </div>
          )}
          {sourcePie.length > 0 && (
            <div>
              <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase mb-2">By Source</h3>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
                <DonutChart data={sourcePie} />
              </div>
            </div>
          )}
        </div>

        {/* ─── By Project ──────────────────────────────── */}
        {data.byProject.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase mb-2">By Project</h3>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 space-y-1.5">
              {data.byProject.map(p => (
                <div key={p.name} className="flex items-center gap-2 text-[10px]">
                  <span className="text-[var(--text-primary)] w-28 truncate shrink-0" title={p.name}>{p.name}</span>
                  <Bar value={p.cost} max={maxProjectCost} color="bg-blue-500" />
                  <span className="text-[var(--text-primary)] w-16 text-right shrink-0 font-mono">{formatCost(p.cost)}</span>
                  <span className="text-[var(--text-secondary)] w-12 text-right shrink-0">{p.sessions}s</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── By Model detailed table ─────────────────── */}
        {data.byModel.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase mb-2">Model Details</h3>
            <div className="border border-[var(--border)] rounded-lg overflow-hidden">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    <th className="text-left px-3 py-1.5">Model</th>
                    <th className="text-right px-3 py-1.5">Input</th>
                    <th className="text-right px-3 py-1.5">Output</th>
                    <th className="text-right px-3 py-1.5">Cost</th>
                    <th className="text-right px-3 py-1.5">Msgs</th>
                    <th className="text-right px-3 py-1.5">Avg/Msg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map(m => (
                    <tr key={m.model} className="border-t border-[var(--border)]/30">
                      <td className="px-3 py-1.5 text-[var(--text-primary)]">{m.model}</td>
                      <td className="px-3 py-1.5 text-right text-[var(--text-secondary)] font-mono">{formatTokens(m.input)}</td>
                      <td className="px-3 py-1.5 text-right text-[var(--text-secondary)] font-mono">{formatTokens(m.output)}</td>
                      <td className="px-3 py-1.5 text-right text-[var(--text-primary)] font-medium font-mono">{formatCost(m.cost)}</td>
                      <td className="px-3 py-1.5 text-right text-[var(--text-secondary)]">{m.messages}</td>
                      <td className="px-3 py-1.5 text-right text-[var(--text-secondary)] font-mono">
                        {m.messages > 0 ? `$${(m.cost / m.messages).toFixed(3)}` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ─── Summary stats ────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded p-2">
            <div className="text-[8px] text-[var(--text-secondary)] uppercase">Avg per session</div>
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">{formatCost(stats.avgPerSession)}</div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded p-2">
            <div className="text-[8px] text-[var(--text-secondary)] uppercase">Avg per message</div>
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">${stats.avgPerMsg.toFixed(3)}</div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded p-2">
            <div className="text-[8px] text-[var(--text-secondary)] uppercase">Sessions / day</div>
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">
              {data.byDay.length > 0 ? (data.total.sessions / data.byDay.length).toFixed(1) : '0'}
            </div>
          </div>
        </div>

        {/* Note */}
        <div className="text-[9px] text-[var(--text-secondary)] border-t border-[var(--border)] pt-3">
          Cost estimates based on API pricing (Opus: $15/$75 per M tokens, Sonnet: $3/$15).
          Cache reads are ~90% cheaper. Actual cost may differ with Claude Max/Pro subscription.
        </div>
      </div>
    </div>
  );
}
