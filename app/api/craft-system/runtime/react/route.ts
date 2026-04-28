// Re-export host's React instance to crafts (avoids two-React problem).
// CraftTabs sets `window.__forge_react` before any craft module is imported.

export async function GET() {
  const code = `
const R = (typeof window !== 'undefined' && window.__forge_react) || null;
if (!R) throw new Error('Forge React shim not initialized');
export default R;
export const useState = R.useState;
export const useEffect = R.useEffect;
export const useCallback = R.useCallback;
export const useMemo = R.useMemo;
export const useRef = R.useRef;
export const useContext = R.useContext;
export const useReducer = R.useReducer;
export const useLayoutEffect = R.useLayoutEffect;
export const createContext = R.createContext;
export const createElement = R.createElement;
export const Fragment = R.Fragment;
export const memo = R.memo;
export const lazy = R.lazy;
export const Suspense = R.Suspense;
export const forwardRef = R.forwardRef;
`;
  return new Response(code, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
}
