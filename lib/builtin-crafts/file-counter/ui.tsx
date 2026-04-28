import { useProject, useForgeFetch, useInject } from '@forge/craft';

interface CountData {
  items: { ext: string; count: number }[];
  total: number;
}

interface LargeData {
  items: { sizeKb: number; path: string }[];
}

export default function FileCounterTab() {
  const { projectName } = useProject();
  const counts = useForgeFetch<CountData>('/api/crafts/file-counter/count');
  const large = useForgeFetch<LargeData>('/api/crafts/file-counter/largest');
  const inject = useInject();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto p-4 gap-4 text-xs">
      <div>
        <h2 className="text-sm font-semibold mb-2">📊 {projectName} — file extensions</h2>
        {counts.loading && <div className="text-[var(--text-secondary)]">Loading…</div>}
        {counts.error && <div className="text-red-400">Error: {counts.error}</div>}
        {counts.data && (
          <>
            <div className="text-[var(--text-secondary)] mb-2">{counts.data.total.toLocaleString()} files total</div>
            <div className="grid grid-cols-2 gap-1">
              {counts.data.items.map(it => (
                <div key={it.ext} className="flex justify-between px-2 py-1 bg-[var(--bg-tertiary)]/40 rounded">
                  <span className="font-mono text-[var(--accent)]">{it.ext}</span>
                  <span>{it.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold mb-2">📦 Largest files</h2>
        {large.data && (
          <table className="w-full">
            <tbody>
              {large.data.items.map((it, i) => (
                <tr key={i} className="hover:bg-[var(--bg-secondary)]/40">
                  <td className="px-2 py-0.5 text-right text-[var(--text-secondary)] w-24 font-mono">
                    {it.sizeKb >= 1024 ? `${(it.sizeKb / 1024).toFixed(1)}MB` : `${it.sizeKb}KB`}
                  </td>
                  <td className="px-2 py-0.5 font-mono break-all">{it.path}</td>
                  <td className="px-2 py-0.5 text-right">
                    <button onClick={() => inject(`Read ${it.path}`)}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30">
                      → terminal
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex gap-2 mt-2">
        <button onClick={() => { counts.refetch(); large.refetch(); }}
          className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30">
          ↻ Refresh
        </button>
      </div>
    </div>
  );
}
