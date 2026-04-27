package com.aion0.forge.ui.toolwindow

/** Typed payloads attached to DefaultMutableTreeNode.userObject so click /
 *  right-click handlers can branch on what was clicked. The `label` is what
 *  ends up rendered (we just call .toString()). */
sealed class TreeNodeData(val label: String) {
    override fun toString(): String = label

    // ── Workspaces tab ─────────────────────────────────────
    class Workspace(label: String, val workspaceId: String, val projectName: String, val daemonActive: Boolean) : TreeNodeData(label)
    class Smith(label: String, val workspaceId: String, val agentId: String, val agentLabel: String, val taskStatus: String, val paused: Boolean, val tmuxSession: String?) : TreeNodeData(label)
    // ── Terminals tab ──────────────────────────────────────
    /** A forge project (from /api/projects). Expand → list of sessions; right-click → new terminal. */
    class LocalProject(label: String, val projectPath: String, val projectName: String) : TreeNodeData(label)
    /** A claude session belonging to a project. Double-click → resume in IDE terminal. */
    class ClaudeSession(label: String, val projectPath: String, val projectName: String, val sessionId: String, val isBound: Boolean) : TreeNodeData(label)
    /** "+ New session…" leaf shown under each project. */
    class NewSession(label: String, val projectPath: String, val projectName: String) : TreeNodeData(label)

    // ── Pipelines tab ──────────────────────────────────────
    class PipelineProject(label: String, val projectPath: String, val projectName: String) : TreeNodeData(label)
    class PipelineBinding(label: String, val projectPath: String, val projectName: String, val workflowName: String, val enabled: Boolean) : TreeNodeData(label)
    class PipelineRun(label: String, val pipelineId: String, val workflowName: String, val status: String) : TreeNodeData(label)
    class PipelineNode(label: String, val pipelineId: String, val nodeName: String, val status: String, val error: String?, val taskId: String?) : TreeNodeData(label)

    // ── Docs tab ───────────────────────────────────────────
    class DocRoot(label: String, val rootIdx: Int, val rootPath: String, val rootName: String) : TreeNodeData(label)
    class DocDir(label: String, val rootIdx: Int, val rootPath: String, val relPath: String) : TreeNodeData(label)
    class DocFile(label: String, val rootIdx: Int, val rootPath: String, val relPath: String, val fileType: String?) : TreeNodeData(label)

    // ── Misc ───────────────────────────────────────────────
    class Hint(label: String) : TreeNodeData(label)
}
