// SDK shim — re-exports the SDK that the host page injected on window.__forge_sdk.
export async function GET() {
  const code = `
const S = (typeof window !== 'undefined' && window.__forge_sdk) || null;
if (!S) throw new Error('Forge SDK shim not initialized');
export const useProject = S.useProject;
export const useForgeFetch = S.useForgeFetch;
export const useInject = S.useInject;
export const useTask = S.useTask;
export const useStore = S.useStore;
export const useOpenAPI = S.useOpenAPI;
export const useFile = S.useFile;
export const useShell = S.useShell;
export const useGit = S.useGit;
export const useToast = S.useToast;
`;
  return new Response(code, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
}
