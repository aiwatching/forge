import { defineCraftServer } from '@forge/craft/server';

export default defineCraftServer({
  routes: {
    'GET /count': async ({ forge }) => {
      // Use git ls-files when available (respects .gitignore), else find.
      const cmd = `git ls-files 2>/dev/null | grep -v '^$' | awk -F. '{ if (NF>1) print $NF; else print "(no-ext)" }' | sort | uniq -c | sort -rn | head -40 || \
        find . -type f -not -path './node_modules/*' -not -path './.git/*' | awk -F. '{ if (NF>1) print $NF; else print "(no-ext)" }' | sort | uniq -c | sort -rn | head -40`;
      const r = forge.exec(cmd, { timeout: 10000 });
      const items = r.stdout.split('\n').filter(Boolean).map(line => {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        return m ? { ext: m[2], count: Number(m[1]) } : null;
      }).filter(Boolean);
      return { items, total: items.reduce((s, x) => s + (x?.count || 0), 0) };
    },

    'GET /largest': async ({ forge }) => {
      const r = forge.exec(
        `find . -type f -not -path './node_modules/*' -not -path './.git/*' -exec du -k {} + 2>/dev/null | sort -rn | head -20`,
        { timeout: 15000 }
      );
      const items = r.stdout.split('\n').filter(Boolean).map(line => {
        const [size, ...rest] = line.trim().split(/\s+/);
        return { sizeKb: Number(size), path: rest.join(' ') };
      });
      return { items };
    },
  },
});
