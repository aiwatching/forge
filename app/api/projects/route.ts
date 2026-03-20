import { NextResponse } from 'next/server';
import { scanProjects } from '@/lib/projects';
import { applyDefaultTemplates, listTemplates } from '@/lib/claude-templates';

// Track known projects to detect new ones
const knownProjects = new Set<string>();

export async function GET() {
  const projects = scanProjects();

  // Auto-apply default templates to newly detected projects
  const hasDefaults = listTemplates().some(t => t.isDefault);
  if (hasDefaults) {
    for (const p of projects) {
      if (!knownProjects.has(p.path)) {
        knownProjects.add(p.path);
        try { applyDefaultTemplates(p.path); } catch {}
      }
    }
  } else {
    // Still track projects even without defaults
    for (const p of projects) knownProjects.add(p.path);
  }

  return NextResponse.json(projects);
}
