// Server-side SDK — used by craft authors in their `server.ts` file.

import type { CraftServerDef, CraftRouteHandler } from '@/lib/crafts/types';

export function defineCraftServer(def: CraftServerDef): CraftServerDef {
  // Identity wrapper for type checking + future validation hooks.
  if (!def || typeof def !== 'object' || !def.routes) {
    throw new Error('defineCraftServer: routes is required');
  }
  return def;
}

// Re-export types so authors can `import type { ... } from '@forge/craft/server'`.
export type { CraftServerDef, CraftRouteHandler, ForgeServerApi, CraftRouteHandlerCtx } from '@/lib/crafts/types';
