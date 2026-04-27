package com.aion0.forge.action

import com.aion0.forge.api.ForgeClient
import com.aion0.forge.connection.ConnectionManager
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages

class LoginAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val active = ConnectionManager.get().active()
        val pw = Messages.showPasswordDialog(
            project,
            "Admin password for ${active.name} (${active.serverUrl})",
            "Forge Login",
            null,
        ) ?: return

        ProgressManager().queue(project, "Forge: signing in") {
            val res = ForgeClient.get().login(pw)
            ApplicationManager.getApplication().invokeLater {
                val group = NotificationGroupManager.getInstance().getNotificationGroup("Forge")
                if (res.ok) {
                    group.createNotification("Forge: logged in to ${active.name}", NotificationType.INFORMATION)
                        .notify(project)
                } else {
                    group.createNotification("Forge login failed: ${res.error}", NotificationType.ERROR)
                        .notify(project)
                }
            }
        }
    }
}

private class ProgressManager {
    fun queue(project: com.intellij.openapi.project.Project?, title: String, work: () -> Unit) {
        com.intellij.openapi.progress.ProgressManager.getInstance().run(
            object : Task.Backgroundable(project, title, false) {
                override fun run(indicator: ProgressIndicator) { work() }
            },
        )
    }
}
