package com.aion0.forge.ui.toolwindow

import com.aion0.forge.connection.ConnectionListener
import com.aion0.forge.connection.ForgeConnection
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.PopupHandler
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.Alarm
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JPanel
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

/**
 * Common boilerplate for the four Forge tool-window tabs.
 *
 *   - Tree component wrapped in a scroll pane
 *   - Toolbar with a refresh button
 *   - Auto-refresh every 5 s
 *   - Refresh on active-connection change
 *
 * Subclasses override [reload] to populate the [root] node and [refreshUi].
 */
abstract class ForgeTreeView(protected val project: Project) : Disposable {
    protected val root: DefaultMutableTreeNode = DefaultMutableTreeNode(rootLabel())
    protected val treeModel = DefaultTreeModel(root)
    protected val tree = Tree(treeModel).apply {
        isRootVisible = false
        showsRootHandles = true
    }
    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    /** Build the panel — wrap toolbar + tree in a JPanel. */
    fun component(): JPanel {
        val panel = JPanel(BorderLayout())
        // Toolbar
        val actions = DefaultActionGroup().apply {
            add(RefreshAction())
            toolbarActions(this)
        }
        val toolbar = ActionManager.getInstance().createActionToolbar("ForgeView", actions, true)
        toolbar.targetComponent = tree
        panel.add(toolbar.component, BorderLayout.NORTH)
        // Tree
        panel.add(ScrollPaneFactory.createScrollPane(tree), BorderLayout.CENTER)
        // Click + right-click handlers — subclasses override.
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2 && !e.isPopupTrigger) {
                    val path = tree.getPathForLocation(e.x, e.y) ?: return
                    val node = path.lastPathComponent as? DefaultMutableTreeNode ?: return
                    val data = node.userObject as? TreeNodeData ?: return
                    onDoubleClick(data, node)
                }
            }
        })
        PopupHandler.installPopupMenu(tree, object : DefaultActionGroup() {
            override fun getChildren(e: AnActionEvent?): Array<AnAction> {
                val node = selectedNode() ?: return emptyArray()
                val data = node.userObject as? TreeNodeData ?: return emptyArray()
                return contextActions(data, node).toTypedArray()
            }
        }, "ForgeViewPopup")

        // Listen for connection changes → reload.
        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(ConnectionListener.TOPIC, object : ConnectionListener {
                override fun onConnectionChanged(active: ForgeConnection) = scheduleReload()
            })

        scheduleReload()
        // Periodic 5s refresh.
        startPolling()
        return panel
    }

    private fun startPolling() {
        // Tail-recursive scheduling so we always wait 5s after each completion.
        if (!Disposer.isDisposed(this)) {
            alarm.addRequest({
                doReloadAsync()
                startPolling()
            }, 5_000)
        }
    }

    private fun scheduleReload() {
        alarm.cancelAllRequests()
        alarm.addRequest({ doReloadAsync() }, 50)
    }

    private fun doReloadAsync() {
        val newChildren = runCatching { reload() }.getOrElse {
            listOf(DefaultMutableTreeNode("⚠ ${it.message ?: "error"}"))
        }
        ApplicationManager.getApplication().invokeLater {
            // Snapshot the userObject-string path of every expanded node so we can
            // re-expand them after the tree is rebuilt — otherwise the 5s poll
            // collapses anything the user opened (Docs subfolders, Pipeline runs, …).
            val expanded = collectExpandedPaths()
            root.removeAllChildren()
            for (n in newChildren) root.add(n)
            treeModel.reload(root)
            reExpand(expanded)
            // Continue polling unless we've been disposed.
            if (Disposer.isDisposed(this)) alarm.cancelAllRequests()
        }
    }

    /** Path identity of every expanded node, keyed by the chain of userObject
     *  toStrings from root → leaf (root itself excluded). */
    private fun collectExpandedPaths(): Set<List<String>> {
        val out = mutableSetOf<List<String>>()
        val descendants = tree.getExpandedDescendants(TreePath(root.path)) ?: return out
        while (descendants.hasMoreElements()) {
            val tp = descendants.nextElement()
            val parts = tp.path
            if (parts.size <= 1) continue
            out.add((1 until parts.size).map { (parts[it] as DefaultMutableTreeNode).userObject?.toString().orEmpty() })
        }
        return out
    }

    private fun reExpand(expanded: Set<List<String>>) {
        if (expanded.isEmpty()) return
        fun visit(node: DefaultMutableTreeNode, prefix: List<String>) {
            for (i in 0 until node.childCount) {
                val child = node.getChildAt(i) as DefaultMutableTreeNode
                val key = prefix + (child.userObject?.toString().orEmpty())
                if (key in expanded) tree.expandPath(TreePath(child.path))
                visit(child, key)
            }
        }
        visit(root, emptyList())
    }

    /** Build the children of the synthetic root (top-level rows the user sees). */
    protected abstract fun reload(): List<DefaultMutableTreeNode>

    /** Override to add view-specific buttons to the toolbar (after Refresh). */
    protected open fun toolbarActions(group: DefaultActionGroup) {}

    /** Override to handle a left double-click on a typed tree node. */
    protected open fun onDoubleClick(data: TreeNodeData, node: DefaultMutableTreeNode) {}

    /** Override to add right-click menu items for a typed tree node. */
    protected open fun contextActions(data: TreeNodeData, node: DefaultMutableTreeNode): List<AnAction> = emptyList()

    /** Label for the hidden synthetic root — never shown but useful as a key. */
    protected open fun rootLabel(): String = "ROOT"

    /** Trigger a refresh from subclasses (e.g. after running an action). */
    fun refresh() = scheduleReload()

    protected fun selectedNode(): DefaultMutableTreeNode? =
        tree.lastSelectedPathComponent as? DefaultMutableTreeNode

    override fun dispose() {
        alarm.cancelAllRequests()
    }

    private inner class RefreshAction : AnAction("Refresh", "Refresh from Forge", com.intellij.icons.AllIcons.Actions.Refresh) {
        override fun actionPerformed(e: AnActionEvent) = scheduleReload()
    }
}
