package com.aion0.forge.action

import com.aion0.forge.connection.ConnectionManager
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class OpenWebUIAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val url = ConnectionManager.get().active().serverUrl
        BrowserUtil.browse(url)
    }
}
