package com.aion0.forge.ui.toolwindow

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory

class ForgeToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val cf = ContentFactory.getInstance()
        addView(toolWindow, cf, "Workspaces", WorkspacesView(project))
        addView(toolWindow, cf, "Terminals",  TerminalsView(project))
        addView(toolWindow, cf, "Pipelines",  PipelinesView(project))
        addView(toolWindow, cf, "Docs",       DocsView(project))
    }

    private fun addView(tw: ToolWindow, cf: ContentFactory, name: String, view: ForgeTreeView) {
        val content: Content = cf.createContent(view.component(), name, false)
        // Tie the view's lifecycle to the tab content so background polling
        // stops when the user closes the tool window.
        Disposer.register(content, view)
        tw.contentManager.addContent(content)
    }
}
