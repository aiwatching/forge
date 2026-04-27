package com.aion0.forge.ui.toolwindow

import com.aion0.forge.api.ApiResult
import com.aion0.forge.api.ForgeClient
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project

internal fun notify(project: Project?, message: String, type: NotificationType = NotificationType.INFORMATION) {
    NotificationGroupManager.getInstance().getNotificationGroup("Forge")
        .createNotification(message, type)
        .notify(project)
}

internal fun runBg(project: Project?, title: String, work: () -> Unit) {
    ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, false) {
        override fun run(indicator: ProgressIndicator) { work() }
    })
}

/** Convenience: run an API call on a bg thread, then show a success/failure
 *  notification on EDT, then call onSuccess (used to trigger view refreshes). */
internal fun runApi(project: Project?, title: String, call: () -> ApiResult, onSuccess: () -> Unit = {}) {
    runBg(project, title) {
        val res = call()
        ApplicationManager.getApplication().invokeLater {
            if (res.ok) {
                notify(project, "Forge: $title — ok")
                onSuccess()
            } else {
                notify(project, "Forge: $title failed — ${res.error}", NotificationType.ERROR)
            }
        }
    }
}

/** WS action against the workspace daemon: POST /api/workspace/<id>/agents
 *  with `{action, agentId, ...}`. */
internal fun wsAction(workspaceId: String, action: String, body: Map<String, Any> = emptyMap()): ApiResult =
    ForgeClient.get().request(
        "/api/workspace/$workspaceId/agents",
        method = "POST",
        body = mapOf("action" to action) + body,
    )
