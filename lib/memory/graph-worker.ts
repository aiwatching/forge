/**
 * Code Graph Worker — runs AST scanning in a separate thread.
 * Called from forge-mcp-server to avoid blocking the main event loop.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { buildCodeGraph, findAffectedBy, incrementalUpdate } from './code-graph.js';

const { action, projectPath, query, existingGraph, changedFiles } = workerData;

try {
  let result: any;

  switch (action) {
    case 'build':
      result = buildCodeGraph(projectPath);
      break;
    case 'query':
      result = findAffectedBy(existingGraph, query);
      break;
    case 'incremental':
      result = incrementalUpdate(existingGraph, projectPath, changedFiles);
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  parentPort?.postMessage({ ok: true, result });
} catch (err: any) {
  parentPort?.postMessage({ ok: false, error: err.message });
}
