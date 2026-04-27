package com.aion0.forge.ui.toolwindow

import com.aion0.forge.api.ForgeClient
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import org.jetbrains.plugins.terminal.LocalTerminalDirectRunner
import org.jetbrains.plugins.terminal.ShellStartupOptions
import org.jetbrains.plugins.terminal.TerminalTabState
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
import java.net.URLEncoder
import javax.swing.tree.DefaultMutableTreeNode

/**
 * Project-keyed terminal launcher.
 *
 * Each top-level node is a forge project. Expand it to see its claude sessions
 * (most-recent first, bound session marked ★). Double-click a session resumes
 * exactly that session via `claude --resume <id>`. Right-click → Open With
 * lists every configured agent for a fresh launch.
 *
 * Agents are spawned **directly as the pty process** via a custom
 * [LocalTerminalDirectRunner]: no shell, no `executeCommand`, so there is no
 * race with prompt-detection or shell startup that could swallow keystrokes.
 */
class TerminalsView(project: Project) : ForgeTreeView(project) {

    /** Cached list of enabled agents — refreshed on every reload so the project
     *  right-click submenu can list them synchronously. */
    @Volatile private var agentsCache: List<Triple<String, String, String?>> = emptyList()

    override fun rootLabel() = "terminals"

    override fun reload(): List<DefaultMutableTreeNode> {
        // Refresh agent cache for the right-click submenu (cheap; ignore failures).
        ForgeClient.get().request("/api/agents").let { ar ->
            if (ar.ok && ar.data?.isJsonObject == true) {
                agentsCache = ar.data.asJsonObject.getAsJsonArray("agents")?.toList()?.mapNotNull { el ->
                    val o = el.asJsonObject
                    if (o.get("enabled")?.asBoolean == false) return@mapNotNull null
                    val id = o.get("id")?.asString ?: return@mapNotNull null
                    val name = o.get("name")?.asString ?: id
                    Triple(id, name, o.get("cliType")?.asString)
                }.orEmpty()
            }
        }

        val r = ForgeClient.get().request("/api/projects")
        if (r.status == 401 || r.status == 403) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("🔑 Tools → Forge: Login")))
        if (!r.ok || r.data == null || !r.data.isJsonArray) {
            return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("⚠ ${r.error ?: "Not connected"}")))
        }
        val arr = r.data.asJsonArray
        if (arr.size() == 0) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("No projects yet")))

        return arr.toList()
            .sortedBy { it.asJsonObject.get("name")?.asString ?: "" }
            .mapNotNull { el ->
                val p = el.asJsonObject
                val name = p.get("name")?.asString ?: return@mapNotNull null
                val path = p.get("path")?.asString ?: return@mapNotNull null
                val node = DefaultMutableTreeNode(TreeNodeData.LocalProject("📁 $name", path, name))

                val bs = ForgeClient.get().request("/api/project-sessions?projectPath=${URLEncoder.encode(path, "UTF-8")}")
                val boundId = bs.data?.asJsonObject?.get("fixedSessionId")?.takeUnless { it.isJsonNull }?.asString

                val ss = ForgeClient.get().request("/api/claude-sessions/${URLEncoder.encode(name, "UTF-8")}")
                val sessions = ss.data?.takeIf { it.isJsonArray }?.asJsonArray?.toList() ?: emptyList()

                sessions.take(10).forEach { sEl ->
                    val s = sEl.asJsonObject
                    val sid = s.get("sessionId")?.asString ?: return@forEach
                    val mtime = s.get("modified")?.asString ?: ""
                    val isBound = sid == boundId
                    val mark = if (isBound) "★" else "·"
                    val pretty = mtime.take(19).replace('T', ' ')
                    node.add(DefaultMutableTreeNode(
                        TreeNodeData.ClaudeSession("$mark ${sid.take(8)}  $pretty", path, name, sid, isBound),
                    ))
                }
                node.add(DefaultMutableTreeNode(TreeNodeData.NewSession("➕ New session…", path, name)))
                node
            }
    }

    override fun onDoubleClick(data: TreeNodeData, node: DefaultMutableTreeNode) {
        when (data) {
            is TreeNodeData.ClaudeSession -> resumeClaudeSession(data)
            is TreeNodeData.NewSession    -> promptAgentAndLaunch(data.projectPath, data.projectName, resumeSessionId = null)
            is TreeNodeData.LocalProject  -> promptAgentAndLaunch(data.projectPath, data.projectName, resumeSessionId = null)
            else -> {}
        }
    }

    override fun contextActions(data: TreeNodeData, node: DefaultMutableTreeNode): List<AnAction> = when (data) {
        is TreeNodeData.LocalProject -> buildList {
            add(buildOpenWithGroup(data.projectPath, data.projectName, resumeSessionId = null, label = "Open With (fresh)"))
            add(act("New Session… (pick agent)", AllIcons.General.Add) { promptAgentAndLaunch(data.projectPath, data.projectName, resumeSessionId = null) })
            add(act("Plain Terminal Here", AllIcons.Debugger.Console) { openPlainTerminal(data.projectPath, data.projectName) })
        }
        is TreeNodeData.ClaudeSession -> buildList {
            add(act("Resume (claude)", AllIcons.Actions.Execute) { resumeClaudeSession(data) })
            add(buildOpenWithGroup(data.projectPath, data.projectName, resumeSessionId = data.sessionId, label = "Resume With…"))
            if (!data.isBound) add(act("Pin as Default Session", AllIcons.Nodes.Favorite) { bindSession(data) })
        }
        is TreeNodeData.NewSession -> listOf(
            buildOpenWithGroup(data.projectPath, data.projectName, resumeSessionId = null, label = "Open With (fresh)"),
            act("New Session… (pick agent)", AllIcons.General.Add) { promptAgentAndLaunch(data.projectPath, data.projectName, resumeSessionId = null) },
        )
        else -> emptyList()
    }

    /** Submenu listing each cached agent — clicking one launches with the given resume mode. */
    private fun buildOpenWithGroup(projectPath: String, projectName: String, resumeSessionId: String?, label: String): DefaultActionGroup {
        val group = DefaultActionGroup(label, true)
        group.isPopup = true
        val ags = agentsCache
        if (ags.isEmpty()) {
            group.add(act("(loading agents — try again)", null) {})
        } else {
            for ((id, name, type) in ags) {
                val item = if (type != null) "$name  ($type)" else name
                group.add(act(item, null) { launchAgent(projectPath, projectName, id, name, resumeSessionId) })
            }
        }
        return group
    }

    /** Resume a specific claude session — picks the first claude-type agent automatically. */
    private fun resumeClaudeSession(s: TreeNodeData.ClaudeSession) {
        runBg(project, "Resuming ${s.sessionId.take(8)}") {
            val ar = ForgeClient.get().request("/api/agents")
            val agents = ar.data?.asJsonObject?.getAsJsonArray("agents")?.toList()?.map { it.asJsonObject } ?: emptyList()
            val claude = agents.firstOrNull {
                val t = it.get("type")?.asString ?: it.get("cliType")?.asString
                t == "claude-code"
            } ?: agents.firstOrNull { it.get("id")?.asString?.startsWith("claude") == true }
            if (claude == null) {
                ApplicationManager.getApplication().invokeLater {
                    notify(project, "Forge: no claude agent configured — open New Session… to pick another agent.", com.intellij.notification.NotificationType.WARNING)
                }
                return@runBg
            }
            launchAgent(s.projectPath, s.projectName,
                agentId = claude.get("id").asString,
                agentName = claude.get("name")?.asString ?: "claude",
                resumeSessionId = s.sessionId)
        }
    }

    /** Show an agent picker, then launch with the given resume mode. */
    private fun promptAgentAndLaunch(projectPath: String, projectName: String, resumeSessionId: String?) {
        runBg(project, "Loading agents") {
            val ar = ForgeClient.get().request("/api/agents")
            if (!ar.ok || ar.data == null || !ar.data.isJsonObject) {
                ApplicationManager.getApplication().invokeLater {
                    notify(project, "Forge: failed to load agents — ${ar.error ?: "unknown"}", com.intellij.notification.NotificationType.ERROR)
                }
                return@runBg
            }
            val agents = ar.data.asJsonObject.getAsJsonArray("agents")?.toList()?.mapNotNull { el ->
                val o = el.asJsonObject
                if (o.get("enabled")?.asBoolean == false) return@mapNotNull null
                val id = o.get("id")?.asString ?: return@mapNotNull null
                val name = o.get("name")?.asString ?: id
                Triple(id, name, o.get("cliType")?.asString)
            }.orEmpty()
            if (agents.isEmpty()) {
                ApplicationManager.getApplication().invokeLater {
                    notify(project, "Forge: no enabled agents — configure one in the Forge web UI.", com.intellij.notification.NotificationType.WARNING)
                }
                return@runBg
            }
            ApplicationManager.getApplication().invokeLater {
                val labels = agents.map { (_, name, type) -> if (type != null) "$name  ($type)" else name }.toTypedArray()
                val choice = Messages.showEditableChooseDialog(
                    "Choose an agent to launch in $projectName",
                    if (resumeSessionId != null) "Forge: Resume With Agent" else "Forge: New Session",
                    null, labels, labels[0], null,
                ) ?: return@invokeLater
                val idx = labels.indexOf(choice).let { if (it < 0) agents.indexOfFirst { (_, n, _) -> n == choice } else it }
                if (idx < 0) return@invokeLater
                val (agentId, agentName, _) = agents[idx]
                launchAgent(projectPath, projectName, agentId, agentName, resumeSessionId)
            }
        }
    }

    /** Resolve the agent's CLI command + env, build an argv, and spawn it directly
     *  as the pty process — no intermediate shell, so the user sees the agent's UI
     *  immediately with no leftover prompt fragments. */
    private fun launchAgent(projectPath: String, projectName: String, agentId: String, agentName: String, resumeSessionId: String?) {
        runBg(project, "Launching $agentName") {
            val rr = ForgeClient.get().request("/api/agents?resolve=${URLEncoder.encode(agentId, "UTF-8")}")
            val resolved = rr.data?.asJsonObject
            if (!rr.ok || resolved == null) {
                ApplicationManager.getApplication().invokeLater {
                    notify(project, "Forge: cannot resolve $agentName — ${rr.error ?: "unknown"}", com.intellij.notification.NotificationType.ERROR)
                }
                return@runBg
            }
            val cliCmd = resolved.get("cliCmd")?.asString ?: agentId
            val supportsSession = resolved.get("supportsSession")?.asBoolean == true
            val cliType = resolved.get("cliType")?.asString
            // For claude, the API returns `-c` which is `--continue` (zero-arg) — passing a
            // session id after `-c` makes claude treat the id as initial prompt text and
            // resume the *most recent* session instead. Force `--resume` for specific-session
            // launches; this matches what forge's web UI does (see WebTerminal.tsx).
            val resumeFlag = if (cliType == "claude-code" && !resumeSessionId.isNullOrBlank()) {
                "--resume"
            } else {
                resolved.get("resumeFlag")?.asString ?: "--resume"
            }
            val envObj = resolved.getAsJsonObject("env")
            val envMap = mutableMapOf<String, String>()
            envObj?.entrySet()?.forEach { (k, v) -> if (!v.isJsonNull) envMap[k] = v.asString }

            // The resolve endpoint returns `model` separately from `env`. For claude this
            // becomes `--model <name>`; without it the agent silently falls back to claude's
            // default (opus), so a "sonnet" profile would appear to do nothing.
            val model = resolved.get("model")?.takeUnless { it.isJsonNull }?.asString
            val modelFlag = if (cliType == "claude-code" && !model.isNullOrBlank()) {
                " --model " + shellQuote(model)
            } else ""

            val cmdLine = buildString {
                append(cliCmd)
                if (supportsSession && !resumeSessionId.isNullOrBlank()) {
                    append(' ').append(resumeFlag).append(' ').append(shellQuote(resumeSessionId))
                }
                append(modelFlag)
            }
            // Use the user's login shell so .zprofile/.bash_profile gets sourced — IDEA's
            // inherited PATH usually misses /opt/homebrew/bin, ~/.claude/local, etc. where
            // CLI agents actually live. `exec` makes the shell hand off the pty to the agent
            // so when the agent quits the tab closes; if exec fails (cmd not in PATH) we
            // fall through to a diagnostic so the error stays visible.
            val userShell = System.getenv("SHELL")?.takeIf { it.isNotBlank() } ?: "/bin/zsh"
            val script = """
                exec $cmdLine
                echo
                echo "[forge: failed to launch — '$cliCmd' not found in PATH]"
                echo "[forge: PATH=${'$'}PATH]"
                echo
                echo "(this terminal will close in 30s)"
                sleep 30
            """.trimIndent()
            val shellCmd = listOf(userShell, "-l", "-c", script)

            ApplicationManager.getApplication().invokeLater {
                spawnInTerminalTab(projectPath, "forge: $projectName ($agentName)", shellCmd, envMap)
            }
        }
    }

    /** Spawn `shellCmd` as the pty's primary process by intercepting
     *  [LocalTerminalDirectRunner.configureStartupOptions]. */
    private fun spawnInTerminalTab(workingDir: String, tabName: String, shellCmd: List<String>, extraEnv: Map<String, String>) {
        val runner = object : LocalTerminalDirectRunner(project) {
            // Skip RC-file injection / command markers — our pty process isn't a shell.
            override fun enableShellIntegration(): Boolean = false

            override fun configureStartupOptions(baseOptions: ShellStartupOptions): ShellStartupOptions {
                val mergedEnv = HashMap<String, String>().apply {
                    baseOptions.envVariables?.let { putAll(it) }
                    putAll(extraEnv)
                    putIfAbsent("TERM", "xterm-256color")
                }
                return baseOptions.builder()
                    .shellCommand(shellCmd)
                    .workingDirectory(baseOptions.workingDirectory ?: workingDir)
                    .envVariables(mergedEnv)
                    .build()
            }

            override fun getDefaultTabTitle(): String = tabName
        }
        val state = TerminalTabState().apply {
            myTabName = tabName
            myWorkingDirectory = workingDir
        }
        TerminalToolWindowManager.getInstance(project).createNewSession(runner, state)
    }

    private fun openPlainTerminal(projectPath: String, projectName: String) {
        TerminalToolWindowManager.getInstance(project)
            .createShellWidget(projectPath, "forge: $projectName", false, true)
    }

    private fun bindSession(s: TreeNodeData.ClaudeSession) {
        runApi(project, "Pin ${s.sessionId.take(8)}", {
            ForgeClient.get().request(
                "/api/project-sessions",
                method = "POST",
                body = mapOf("projectPath" to s.projectPath, "fixedSessionId" to s.sessionId),
            )
        }) { refresh() }
    }

    private fun shellQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    private fun act(name: String, icon: javax.swing.Icon?, run: () -> Unit) = object : AnAction(name, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }
}
