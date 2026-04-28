// jsx-runtime shim — re-exports from host's React.
export async function GET() {
  const code = `
const J = (typeof window !== 'undefined' && window.__forge_jsx) || null;
if (!J) throw new Error('Forge JSX runtime shim not initialized');
export const jsx = J.jsx;
export const jsxs = J.jsxs;
export const Fragment = J.Fragment;
`;
  return new Response(code, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
}
