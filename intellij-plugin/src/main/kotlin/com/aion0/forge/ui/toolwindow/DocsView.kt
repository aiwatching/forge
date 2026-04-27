package com.aion0.forge.ui.toolwindow

import com.aion0.forge.api.ForgeClient
import com.google.gson.JsonElement
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import org.jetbrains.plugins.terminal.TerminalView
import java.io.File
import javax.swing.tree.DefaultMutableTreeNode

class DocsView(project: Project) : ForgeTreeView(project) {

    override fun rootLabel() = "docs"

    override fun reload(): List<DefaultMutableTreeNode> {
        val r = ForgeClient.get().request("/api/docs")
        if (r.status == 401 || r.status == 403) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("🔑 Tools → Forge: Login")))
        if (!r.ok || r.data == null || !r.data.isJsonObject) {
            return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("⚠ ${r.error ?: "Not connected"}")))
        }
        val roots = r.data.asJsonObject.getAsJsonArray("roots") ?: return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("No doc roots — add one in forge Settings → Doc Roots")))
        val rootPaths = r.data.asJsonObject.getAsJsonArray("rootPaths")
        if (roots.size() == 0) return listOf(DefaultMutableTreeNode(TreeNodeData.Hint("No doc roots")))

        return (0 until roots.size()).map { i ->
            val rootName = roots[i].asString
            val rootPath = rootPaths?.get(i)?.asString ?: rootName
            val node = DefaultMutableTreeNode(TreeNodeData.DocRoot("📚 $rootName", i, rootPath, rootName))
            val sub = ForgeClient.get().request("/api/docs?root=$i")
            sub.data?.asJsonObject?.getAsJsonArray("tree")?.forEach { addChildNode(node, it, i, rootPath) }
            node
        }
    }

    private fun addChildNode(parent: DefaultMutableTreeNode, el: JsonElement, rootIdx: Int, rootPath: String) {
        val obj = el.asJsonObject
        val name = obj.get("name")?.asString ?: "?"
        val type = obj.get("type")?.asString ?: "file"
        val relPath = obj.get("path")?.asString ?: name
        val fileType = obj.get("fileType")?.asString
        val emoji = when {
            type == "dir"        -> "📁"
            fileType == "md"     -> "📄"
            fileType == "image"  -> "🖼"
            else                 -> "📑"
        }
        val data = if (type == "dir") TreeNodeData.DocDir("$emoji $name", rootIdx, rootPath, relPath)
                   else               TreeNodeData.DocFile("$emoji $name", rootIdx, rootPath, relPath, fileType)
        val node = DefaultMutableTreeNode(data)
        if (type == "dir") obj.getAsJsonArray("children")?.forEach { addChildNode(node, it, rootIdx, rootPath) }
        parent.add(node)
    }

    override fun onDoubleClick(data: TreeNodeData, node: DefaultMutableTreeNode) {
        when (data) {
            is TreeNodeData.DocFile -> openFile(data)
            else -> {}
        }
    }

    override fun contextActions(data: TreeNodeData, node: DefaultMutableTreeNode): List<AnAction> = when (data) {
        is TreeNodeData.DocRoot -> listOf(
            act("Open Terminal Here", AllIcons.Debugger.Console) { openTerminalAt(data.rootPath) },
        )
        is TreeNodeData.DocDir -> listOf(
            act("Open Terminal Here", AllIcons.Debugger.Console) { openTerminalAt("${data.rootPath}/${data.relPath}") },
        )
        is TreeNodeData.DocFile -> listOf(
            act("Open", AllIcons.Actions.Edit) { openFile(data) },
        )
        else -> emptyList()
    }

    /** Open the file via the local filesystem (forge is local-by-default —
     *  remote forges would need an HTTP-backed VFS, deferred). */
    private fun openFile(f: TreeNodeData.DocFile) {
        val abs = File(f.rootPath, f.relPath)
        if (!abs.isFile) {
            notify(project, "Forge: file not found locally — ${abs.absolutePath} (remote forge support TBD)", com.intellij.notification.NotificationType.WARNING)
            return
        }
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(abs) ?: return
        FileEditorManager.getInstance(project).openFile(vf, true)
    }

    private fun openTerminalAt(absDir: String) {
        val terminalView = TerminalView.getInstance(project)
        val widget = terminalView.createLocalShellWidget(absDir, "forge: ${File(absDir).name}")
        widget.executeCommand("claude --dangerously-skip-permissions")
    }

    private fun act(name: String, icon: javax.swing.Icon?, run: () -> Unit) = object : AnAction(name, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }
}
