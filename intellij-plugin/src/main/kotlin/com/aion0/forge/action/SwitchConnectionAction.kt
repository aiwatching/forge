package com.aion0.forge.action

import com.aion0.forge.connection.ConnectionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep

class SwitchConnectionAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val mgr = ConnectionManager.get()
        val items = mgr.list().map { it.name }
        if (items.isEmpty()) return
        val active = mgr.active().name
        val popup = JBPopupFactory.getInstance()
            .createListPopup(object : BaseListPopupStep<String>("Switch Forge Connection", items) {
                override fun getDefaultOptionIndex(): Int = items.indexOf(active).coerceAtLeast(0)
                override fun onChosen(selectedValue: String, finalChoice: Boolean): PopupStep<*>? {
                    mgr.setActive(selectedValue)
                    return PopupStep.FINAL_CHOICE
                }
            })
        popup.showInBestPositionFor(e.dataContext)
    }
}
