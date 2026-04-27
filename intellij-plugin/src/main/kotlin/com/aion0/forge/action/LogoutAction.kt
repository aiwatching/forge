package com.aion0.forge.action

import com.aion0.forge.api.ForgeClient
import com.aion0.forge.connection.ConnectionManager
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class LogoutAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val active = ConnectionManager.get().active()
        ForgeClient.get().logout()
        NotificationGroupManager.getInstance().getNotificationGroup("Forge")
            .createNotification("Forge: logged out of ${active.name}", NotificationType.INFORMATION)
            .notify(e.project)
    }
}
