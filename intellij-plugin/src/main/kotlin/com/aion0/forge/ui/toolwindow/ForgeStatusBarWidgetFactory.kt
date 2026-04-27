package com.aion0.forge.ui.toolwindow

import com.aion0.forge.api.ForgeClient
import com.aion0.forge.auth.Auth
import com.aion0.forge.connection.ConnectionListener
import com.aion0.forge.connection.ConnectionManager
import com.aion0.forge.connection.ForgeConnection
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Alarm
import java.awt.event.MouseEvent
import javax.swing.Timer

class ForgeStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = "com.aion0.forge.statusbar"
    override fun getDisplayName(): String = "Forge"
    override fun isAvailable(project: Project): Boolean = true
    override fun createWidget(project: Project): StatusBarWidget = ForgeStatusBarWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) {}
    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

class ForgeStatusBarWidget(private val project: Project) : StatusBarWidget,
    StatusBarWidget.TextPresentation {

    private var statusBar: StatusBar? = null
    // `this` is a Disposable (StatusBarWidget extends Disposable). The Alarm
    // requires a parent Disposable for non-Swing threads — registering with
    // ourselves means the Alarm is auto-disposed when the widget goes away.
    private val alarm: Alarm by lazy { Alarm(Alarm.ThreadToUse.POOLED_THREAD, this) }
    private var lastText: String = "Forge: …"
    private var lastTooltip: String = "Forge"
    private var pollTimer: Timer? = null

    override fun ID(): String = "com.aion0.forge.statusbar"
    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        // Refresh on connection change.
        ApplicationManager.getApplication().messageBus.connect()
            .subscribe(ConnectionListener.TOPIC, object : ConnectionListener {
                override fun onConnectionChanged(active: ForgeConnection) = scheduleRefresh()
            })
        scheduleRefresh()
        // Periodic poll so connectivity changes (server up/down) reflect.
        pollTimer = Timer(5_000) { scheduleRefresh() }.apply { start() }
    }

    override fun dispose() {
        pollTimer?.stop()
        pollTimer = null
        // alarm is disposed automatically (we passed `this` as parent).
    }

    override fun getText(): String = lastText
    override fun getTooltipText(): String = lastTooltip
    override fun getAlignment(): Float = 0f

    override fun getClickConsumer(): com.intellij.util.Consumer<MouseEvent>? =
        com.intellij.util.Consumer { _ ->
            // Click → run "Switch Connection" action.
            val action = ActionManager.getInstance().getAction("com.aion0.forge.action.SwitchConnectionAction")
            ActionManager.getInstance().tryToExecute(action, null, null, "Forge", true)
        }

    private fun scheduleRefresh() {
        alarm.cancelAllRequests()
        alarm.addRequest({
            val conn = ConnectionManager.get().active()
            val reachable = ForgeClient.get().ping()
            val token = Auth.get().getToken(conn.name)
            val text = when {
                !reachable     -> "Forge ⊘ ${conn.name}"
                token.isNullOrBlank() -> "Forge ⚠ ${conn.name}"
                else           -> "Forge ⚡ ${conn.name}"
            }
            val tooltip = when {
                !reachable     -> "${conn.name} — server unreachable (${conn.serverUrl})"
                token.isNullOrBlank() -> "${conn.name} — login required"
                else           -> "${conn.name} — connected (${conn.serverUrl})"
            }
            ApplicationManager.getApplication().invokeLater {
                lastText = text
                lastTooltip = tooltip
                statusBar?.updateWidget(ID())
            }
        }, 100)
    }
}
