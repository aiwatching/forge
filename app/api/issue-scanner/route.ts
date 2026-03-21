import { NextResponse } from 'next/server';
import {
  getConfig,
  saveConfig,
  listConfigs,
  scanAndTrigger,
  restartScanner,
  getProcessedIssues,
  resetProcessedIssue,
  type IssueAutofixConfig,
} from '@/lib/issue-scanner';

// GET /api/issue-scanner?project=PATH — get config + processed issues
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectPath = searchParams.get('project');

  if (projectPath) {
    const config = getConfig(projectPath);
    const processed = getProcessedIssues(projectPath);
    return NextResponse.json({ config, processed });
  }

  // List all enabled configs
  const configs = listConfigs();
  return NextResponse.json({ configs });
}

// POST /api/issue-scanner
export async function POST(req: Request) {
  const body = await req.json();

  // Save config
  if (body.action === 'save-config') {
    const config: IssueAutofixConfig = {
      projectPath: body.projectPath,
      projectName: body.projectName,
      enabled: !!body.enabled,
      interval: body.interval || 30,
      labels: body.labels || [],
      baseBranch: body.baseBranch || '',
    };
    saveConfig(config);
    restartScanner();
    return NextResponse.json({ ok: true });
  }

  // Manual scan & trigger
  if (body.action === 'scan') {
    const config = getConfig(body.projectPath);
    if (!config) return NextResponse.json({ error: 'Not configured' }, { status: 400 });
    const result = scanAndTrigger(config);
    return NextResponse.json(result);
  }

  // Manual trigger for a specific issue
  if (body.action === 'trigger') {
    const { startPipeline } = require('@/lib/pipeline');
    const config = getConfig(body.projectPath);
    const projectName = config?.projectName || body.projectName;
    try {
      const pipeline = startPipeline('issue-auto-fix', {
        issue_id: String(body.issueId),
        project: projectName,
        base_branch: config?.baseBranch || body.baseBranch || 'auto-detect',
      });
      // Track in processed issues
      const { getDb } = require('@/src/core/db/database');
      const { getDbPath } = require('@/src/config');
      getDb(getDbPath()).prepare(`
        INSERT OR REPLACE INTO issue_autofix_processed (project_path, issue_number, pipeline_id, status)
        VALUES (?, ?, ?, 'processing')
      `).run(body.projectPath, body.issueId, pipeline.id);
      return NextResponse.json({ ok: true, pipelineId: pipeline.id });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }

  // Reset a processed issue (allow re-scan)
  if (body.action === 'reset') {
    resetProcessedIssue(body.projectPath, body.issueId);
    return NextResponse.json({ ok: true });
  }

  // Retry with additional context/instructions
  if (body.action === 'retry') {
    const { startPipeline } = require('@/lib/pipeline');
    const config = getConfig(body.projectPath);
    const projectName = config?.projectName || body.projectName;
    // Reset the processed record first, then re-create with new pipeline
    resetProcessedIssue(body.projectPath, body.issueId);
    try {
      const pipeline = startPipeline('issue-auto-fix', {
        issue_id: String(body.issueId),
        project: projectName,
        base_branch: config?.baseBranch || 'auto-detect',
        extra_context: body.context || '',
      });
      // Re-mark as processed with new pipeline ID
      const { getDb } = require('@/src/core/db/database');
      const { getDbPath } = require('@/src/config');
      getDb(getDbPath()).prepare(`
        INSERT OR REPLACE INTO issue_autofix_processed (project_path, issue_number, pipeline_id, status)
        VALUES (?, ?, ?, 'processing')
      `).run(body.projectPath, body.issueId, pipeline.id);
      return NextResponse.json({ ok: true, pipelineId: pipeline.id });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
