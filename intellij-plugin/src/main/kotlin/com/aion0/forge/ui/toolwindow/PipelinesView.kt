package com.aion0.forge.ui.toolwindow

import com.aion0.forge.api.ForgeClient
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.testFramework.LightVirtualFile
import java.net.URLEncoder
import javax.swing.tree.DefaultMutableTreeNode

class PipelinesView(project: Project) : ForgeTreeView(project) {

    override fun rootLabel() = "pipelines"

    override fun reload(): List<DefaultMutableTreeNode> {
        val r = ForgeClient.get().request("/api/projects")
        if (r.status == 401 || r.status == 403) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("🔑 Tools → Forge: Login")))
        if (!r.ok || r.data == null || !r.data.isJsonArray) {
            return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("⚠ ${r.error ?: "Not connected"}")))
        }
        val arr = r.data.asJsonArray
        if (arr.size() == 0) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("No projects")))

        return arr.toList().sortedBy { it.asJsonObject.get("name")?.asString ?: "" }.mapNotNull { el ->
            val p = el.asJsonObject
            val name = p.get("name")?.asString ?: return@mapNotNull null
            val path = p.get("path")?.asString ?: return@mapNotNull null
            val node = DefaultMutableTreeNode(TreeNodeData.PipelineProject("📁 $name", path, name))

            val pp = ForgeClient.get().request("/api/project-pipelines?project=${URLEncoder.encode(path, "UTF-8")}")
            if (pp.ok && pp.data?.isJsonObject == true) {
                val obj = pp.data.asJsonObject
                val bindings = obj.getAsJsonArray("bindings")
                val runs = obj.getAsJsonArray("runs")
                if (bindings == null || bindings.size() == 0) {
                    node.add(DefaultMutableTreeNode(TreeNodeData.Hint("＋ No pipelines yet — right-click to add")))
                } else {
                    for (bEl in bindings) {
                        val b = bEl.asJsonObject
                        val wf = b.get("workflowName")?.asString ?: "?"
                        val enabled = b.get("enabled")?.asBoolean ?: true
                        val schedule = b.getAsJsonObject("config")?.get("schedule")?.asString
                            ?: b.getAsJsonObject("config")?.get("cron")?.asString
                            ?: "manual"
                        val mark = if (enabled) "⚙" else "⊘"
                        node.add(DefaultMutableTreeNode(
                            TreeNodeData.PipelineBinding("$mark $wf  ($schedule)", path, name, wf, enabled),
                        ))
                    }
                }
                if (runs != null && runs.size() > 0) {
                    val runsHead = DefaultMutableTreeNode(TreeNodeData.Hint("📜 Recent Runs"))
                    runs.take(10).forEach { rEl ->
                        val run = rEl.asJsonObject
                        val status = run.get("status")?.asString ?: "?"
                        val wf = run.get("workflowName")?.asString ?: "?"
                        val pipelineId = run.get("pipelineId")?.asString ?: run.get("id")?.asString ?: ""
                        val createdAt = run.get("createdAt")?.asString ?: ""
                        val emoji = when (status) {
                            "running" -> "▶"; "done" -> "✓"; "failed" -> "✕"; "cancelled" -> "⊘"; else -> "·"
                        }
                        runsHead.add(DefaultMutableTreeNode(
                            TreeNodeData.PipelineRun("$emoji $wf  ·  $createdAt", pipelineId, wf, status),
                        ))
                    }
                    node.add(runsHead)
                }
            }
            node
        }
    }

    override fun onDoubleClick(data: TreeNodeData, node: DefaultMutableTreeNode) {
        when (data) {
            is TreeNodeData.PipelineBinding -> triggerBinding(data)
            is TreeNodeData.PipelineRun     -> expandRun(node, data)
            is TreeNodeData.PipelineNode    -> showNodeResult(data)
            else -> {}
        }
    }

    override fun contextActions(data: TreeNodeData, node: DefaultMutableTreeNode): List<AnAction> = when (data) {
        is TreeNodeData.PipelineProject -> listOf(
            act("Add Pipeline…", AllIcons.General.Add) { addPipeline(data) },
        )
        is TreeNodeData.PipelineBinding -> listOf(
            act("Trigger Now",        AllIcons.Actions.Execute) { triggerBinding(data) },
            act(if (data.enabled) "Disable" else "Enable", AllIcons.Actions.ToggleSoftWrap) { toggleBinding(data) },
            act("Remove…",            AllIcons.Actions.Cancel)  { removeBinding(data) },
        )
        is TreeNodeData.PipelineRun -> listOf(
            act("Show Nodes", AllIcons.Actions.Expandall) { expandRun(node, data) },
        )
        is TreeNodeData.PipelineNode -> listOf(
            act("Show Result", AllIcons.Actions.Preview) { showNodeResult(data) },
        )
        else -> emptyList()
    }

    private fun triggerBinding(b: TreeNodeData.PipelineBinding) {
        runApi(project, "Trigger ${b.workflowName}", {
            ForgeClient.get().request(
                "/api/project-pipelines",
                method = "POST",
                body = mapOf("action" to "trigger", "projectPath" to b.projectPath, "projectName" to b.projectName, "workflowName" to b.workflowName, "input" to emptyMap<String, String>()),
            )
        }) { refresh() }
    }

    private fun toggleBinding(b: TreeNodeData.PipelineBinding) {
        val next = !b.enabled
        runApi(project, if (next) "Enable ${b.workflowName}" else "Disable ${b.workflowName}", {
            ForgeClient.get().request(
                "/api/project-pipelines",
                method = "POST",
                body = mapOf("action" to "update", "projectPath" to b.projectPath, "workflowName" to b.workflowName, "enabled" to next),
            )
        }) { refresh() }
    }

    private fun removeBinding(b: TreeNodeData.PipelineBinding) {
        val r = Messages.showYesNoDialog(project, "Remove pipeline \"${b.workflowName}\"?", "Forge", Messages.getQuestionIcon())
        if (r != Messages.YES) return
        runApi(project, "Remove ${b.workflowName}", {
            ForgeClient.get().request(
                "/api/project-pipelines",
                method = "POST",
                body = mapOf("action" to "remove", "projectPath" to b.projectPath, "workflowName" to b.workflowName),
            )
        }) { refresh() }
    }

    private fun addPipeline(p: TreeNodeData.PipelineProject) {
        val pp = ForgeClient.get().request("/api/project-pipelines?project=${URLEncoder.encode(p.projectPath, "UTF-8")}")
        val workflows = pp.data?.asJsonObject?.getAsJsonArray("workflows")?.map { it.asJsonObject.get("name").asString } ?: return
        val bound = pp.data.asJsonObject.getAsJsonArray("bindings")?.map { it.asJsonObject.get("workflowName").asString }?.toSet() ?: emptySet()
        val candidates = workflows.filter { it !in bound }
        if (candidates.isEmpty()) { notify(project, "Forge: all workflows are already bound to ${p.projectName}"); return }
        val choice = Messages.showEditableChooseDialog("Workflow to bind", "Add Pipeline", null, candidates.toTypedArray(), candidates.first(), null) ?: return
        runApi(project, "Add $choice to ${p.projectName}", {
            ForgeClient.get().request(
                "/api/project-pipelines",
                method = "POST",
                body = mapOf("action" to "add", "projectPath" to p.projectPath, "projectName" to p.projectName, "workflowName" to choice, "config" to emptyMap<String, Any>()),
            )
        }) { refresh() }
    }

    private fun expandRun(parent: DefaultMutableTreeNode, run: TreeNodeData.PipelineRun) {
        if (run.pipelineId.isBlank()) { notify(project, "Forge: this run has no pipeline detail id."); return }
        val r = ForgeClient.get().request("/api/pipelines/${run.pipelineId}")
        if (!r.ok || r.data == null || !r.data.isJsonObject) {
            notify(project, "Forge: ${r.error ?: "failed to load run"}", com.intellij.notification.NotificationType.WARNING)
            return
        }
        val nodes = r.data.asJsonObject.getAsJsonObject("nodes")
        val order = r.data.asJsonObject.getAsJsonArray("nodeOrder")
            ?.map { it.asString } ?: nodes?.keySet()?.toList() ?: emptyList()
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            parent.removeAllChildren()
            for (name in order) {
                val n = nodes?.getAsJsonObject(name) ?: continue
                val st = n.get("status")?.asString ?: "pending"
                val err = n.get("error")?.asString
                val taskId = n.get("taskId")?.asString
                val emoji = when (st) {
                    "running" -> "▶"; "done" -> "✓"; "failed" -> "✕"
                    "cancelled" -> "⊘"; "skipped" -> "·"; else -> "·"
                }
                parent.add(DefaultMutableTreeNode(
                    TreeNodeData.PipelineNode("$emoji $name  ($st)", run.pipelineId, name, st, err, taskId),
                ))
            }
            treeModel.reload(parent)
            tree.expandPath(javax.swing.tree.TreePath(parent.path))
        }
    }

    /** Open a markdown buffer with status + error + (if available) the linked
     *  task's prompt / result / log / git diff. */
    private fun showNodeResult(n: TreeNodeData.PipelineNode) {
        runBg(project, "Loading node result") {
            val sb = StringBuilder()
            sb.append("# Pipeline node: `${n.nodeName}`\n\n")
            sb.append("**Status:** ${n.status}\n")
            if (n.taskId != null) sb.append("**Task ID:** `${n.taskId}`\n")
            sb.append("\n")

            if (n.taskId != null) {
                val t = ForgeClient.get().request("/api/tasks/${n.taskId}")
                if (t.ok && t.data?.isJsonObject == true) {
                    val task = t.data.asJsonObject
                    task.get("prompt")?.asString?.let { sb.append("## Prompt\n```\n$it\n```\n\n") }
                    task.get("resultSummary")?.asString?.let { sb.append("## Result\n$it\n\n") }
                    task.get("gitDiff")?.asString?.let { sb.append("## Git Diff\n```diff\n$it\n```\n\n") }
                    val log = task.getAsJsonArray("log")
                    if (log != null && log.size() > 0) {
                        sb.append("## Log (last 20)\n")
                        log.toList().takeLast(20).forEach { e ->
                            val o = e.asJsonObject
                            val tag = o.get("subtype")?.asString ?: o.get("type")?.asString ?: "log"
                            val content = o.get("content")?.asString ?: ""
                            sb.append("- `[$tag]` ${content.take(500).replace("\n", " ")}\n")
                        }
                        sb.append("\n")
                    }
                }
            }
            if (!n.error.isNullOrBlank()) sb.append("## Error\n```\n${n.error}\n```\n")

            val content = sb.toString()
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                val vf = LightVirtualFile("forge-node-${n.nodeName}.md", content)
                vf.isWritable = false
                FileEditorManager.getInstance(project).openFile(vf, true)
            }
        }
    }

    private fun act(name: String, icon: javax.swing.Icon?, run: () -> Unit) = object : AnAction(name, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }
}
