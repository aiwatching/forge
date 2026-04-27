package com.aion0.forge.ui.toolwindow

import com.aion0.forge.api.ForgeClient
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import org.jetbrains.plugins.terminal.ShellTerminalWidget
import org.jetbrains.plugins.terminal.TerminalView
import javax.swing.tree.DefaultMutableTreeNode

class WorkspacesView(project: Project) : ForgeTreeView(project) {

    /** Cache of open smith terminals keyed by tmux session name. Re-clicking a smith
     *  focuses the existing terminal tab instead of spawning a duplicate. */
    private val openedTerminals = mutableMapOf<String, ShellTerminalWidget>()

    override fun rootLabel() = "workspaces"

    override fun reload(): List<DefaultMutableTreeNode> {
        val r = ForgeClient.get().request("/api/workspace")
        if (r.status == 401 || r.status == 403) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("🔑 Tools → Forge: Login")))
        if (!r.ok || r.data == null || !r.data.isJsonArray) {
            return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("⚠ ${r.error ?: "Not connected"}")))
        }
        val arr = r.data.asJsonArray
        if (arr.size() == 0) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("No workspaces yet")))
        val sorted = arr.toList().sortedBy { it.asJsonObject.get("projectName")?.asString ?: "" }
        return sorted.mapNotNull { el ->
            val ws = el.asJsonObject
            val id = ws.get("id")?.asString ?: return@mapNotNull null
            val name = ws.get("projectName")?.asString ?: id
            val ar = ForgeClient.get().request("/api/workspace/$id/agents")
            val agents = ar.data?.asJsonObject?.getAsJsonArray("agents")
            val states = ar.data?.asJsonObject?.getAsJsonObject("states")
            val daemon = ar.data?.asJsonObject?.get("daemonActive")?.asBoolean ?: false
            val mark = if (daemon) "🟢" else "○"
            val node = DefaultMutableTreeNode(TreeNodeData.Workspace("$mark $name  (${agents?.size() ?: 0} smiths)", id, name, daemon))
            agents?.forEach { aEl ->
                val a = aEl.asJsonObject
                val aId = a.get("id")?.asString ?: return@forEach
                val label = a.get("label")?.asString ?: aId
                val icon = a.get("icon")?.asString ?: "🤖"
                val s = states?.getAsJsonObject(aId)
                val task = s?.get("taskStatus")?.asString ?: "idle"
                val smith = s?.get("smithStatus")?.asString ?: "down"
                val paused = s?.get("paused")?.asBoolean == true
                val tmux = s?.get("tmuxSession")?.asString
                val statusEmoji = when {
                    paused             -> "⏸"
                    smith == "down"    -> "○"
                    smith == "starting"-> "◐"
                    task == "running"  -> "▶"
                    task == "failed"   -> "✕"
                    task == "done"     -> "✓"
                    else               -> "·"
                }
                node.add(DefaultMutableTreeNode(
                    TreeNodeData.Smith("$statusEmoji $icon $label  ($task)", id, aId, label, task, paused, tmux),
                ))
            }
            node
        }
    }

    override fun onDoubleClick(data: TreeNodeData, node: DefaultMutableTreeNode) {
        when (data) {
            is TreeNodeData.Smith -> openSmithTerminal(data)
            else -> {}
        }
    }

    override fun contextActions(data: TreeNodeData, node: DefaultMutableTreeNode): List<AnAction> = when (data) {
        is TreeNodeData.Workspace -> if (data.daemonActive) {
            listOf(
                act("Stop Daemon",   AllIcons.Actions.Suspend) { confirmAndDoWs(data.workspaceId, "stop_daemon",  "Stop the workspace daemon? Running smiths will be terminated.") },
                act("Restart Daemon",AllIcons.Actions.Restart) { runApi(project, "Restart daemon", { restartDaemon(data.workspaceId) }) { refresh() } },
            )
        } else {
            listOf(
                act("Start Daemon", AllIcons.Actions.Execute) { runApi(project, "Start daemon", { wsAction(data.workspaceId, "start_daemon") }) { refresh() } },
            )
        }
        is TreeNodeData.Smith -> buildList {
            add(act("Open Terminal", AllIcons.Debugger.Console) { openSmithTerminal(data) })
            add(act("Send Message",  AllIcons.General.Balloon) { promptSendMessage(data) })
            if (data.paused) {
                add(act("Resume", AllIcons.Actions.Execute) { runApi(project, "Resume ${data.agentLabel}", { wsAction(data.workspaceId, "resume", mapOf("agentId" to data.agentId)) }) { refresh() } })
            } else {
                add(act("Pause", AllIcons.Actions.Suspend) { runApi(project, "Pause ${data.agentLabel}", { wsAction(data.workspaceId, "pause", mapOf("agentId" to data.agentId)) }) { refresh() } })
            }
            if (data.taskStatus == "running") {
                add(act("Mark Done",   null) { runApi(project, "Mark done",   { wsAction(data.workspaceId, "mark_done",   mapOf("agentId" to data.agentId, "notify" to true)) }) { refresh() } })
                add(act("Mark Failed", null) { runApi(project, "Mark failed", { wsAction(data.workspaceId, "mark_failed", mapOf("agentId" to data.agentId, "notify" to true)) }) { refresh() } })
                add(act("Mark Idle",   null) { runApi(project, "Mark idle",   { wsAction(data.workspaceId, "mark_done",   mapOf("agentId" to data.agentId, "notify" to false)) }) { refresh() } })
            }
            if (data.taskStatus == "failed") {
                add(act("Retry", AllIcons.Actions.Refresh) { runApi(project, "Retry ${data.agentLabel}", { wsAction(data.workspaceId, "retry", mapOf("agentId" to data.agentId)) }) { refresh() } })
            }
        }
        else -> emptyList()
    }

    private fun confirmAndDoWs(wsId: String, action: String, prompt: String) {
        val r = Messages.showYesNoDialog(project, prompt, "Forge", Messages.getQuestionIcon())
        if (r == Messages.YES) runApi(project, action, { wsAction(wsId, action) }) { refresh() }
    }

    private fun restartDaemon(wsId: String): com.aion0.forge.api.ApiResult {
        val stop = wsAction(wsId, "stop_daemon")
        if (!stop.ok) return stop
        Thread.sleep(800)
        return wsAction(wsId, "start_daemon")
    }

    /** Open an IDE terminal and run `tmux attach -t <session>` — works for
     *  local forge. Remote forge would need a WebSocket-bridged JediTerm
     *  session (TODO). Reuses an existing terminal tab if one was already
     *  opened for this smith. */
    private fun openSmithTerminal(smith: TreeNodeData.Smith) {
        val res = ForgeClient.get().request(
            "/api/workspace/${smith.workspaceId}/agents",
            method = "POST",
            body = mapOf("action" to "open_terminal", "agentId" to smith.agentId),
        )
        val tmux = res.data?.asJsonObject?.get("tmuxSession")?.asString ?: smith.tmuxSession
        if (tmux.isNullOrBlank()) {
            notify(project, "Forge: smith ${smith.agentLabel} has no tmux session yet — start the daemon first.", com.intellij.notification.NotificationType.WARNING)
            return
        }
        val existing = openedTerminals[tmux]
        if (existing != null && !com.intellij.openapi.util.Disposer.isDisposed(existing)) {
            // Surface the existing tab in the Terminal tool window.
            val tw = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Terminal")
            tw?.activate(null)
            existing.requestFocusInWindow()
            return
        }
        val terminalView = TerminalView.getInstance(project)
        val widget = terminalView.createLocalShellWidget(project.basePath ?: System.getProperty("user.home"), "forge: ${smith.agentLabel}")
        openedTerminals[tmux] = widget
        com.intellij.openapi.util.Disposer.register(widget) { openedTerminals.remove(tmux) }
        // Force UTF-8 + 256-color terminfo so the tmux UI doesn't render as garbled
        // box-drawing characters in JediTerm. `-u` opts into UTF-8, `-2` forces 256-color.
        widget.executeCommand("TERM=xterm-256color tmux -2 -u attach -t \"$tmux\" || TERM=xterm-256color tmux -2 -u new -A -s \"$tmux\"")
    }

    private fun promptSendMessage(smith: TreeNodeData.Smith) {
        val text = Messages.showMultilineInputDialog(
            project,
            "Send message to ${smith.agentLabel}",
            "Forge: Send Message",
            "",
            null, null,
        ) ?: return
        if (text.isBlank()) return
        runApi(project, "Send message to ${smith.agentLabel}",
            { wsAction(smith.workspaceId, "message", mapOf("agentId" to smith.agentId, "content" to text)) },
        ) { refresh() }
    }

    private fun act(name: String, icon: javax.swing.Icon?, run: () -> Unit) = object : AnAction(name, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }
}
