package com.aion0.forge.settings

import com.aion0.forge.connection.ConnectionManager
import com.aion0.forge.connection.ForgeConnection
import com.intellij.openapi.options.Configurable
import com.intellij.ui.ToolbarDecorator
import com.intellij.ui.table.JBTable
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.table.DefaultTableModel

/** "Tools → Forge" preferences pane: edit the list of connections and pick the
 *  active one. Tokens are stored separately in PasswordSafe (cleared via the
 *  Forge: Logout action). */
class ForgeConfigurable : Configurable {
    private lateinit var rootPanel: JPanel
    private lateinit var activeNameField: JTextField
    private lateinit var tableModel: DefaultTableModel
    private lateinit var table: JBTable

    override fun getDisplayName(): String = "Forge"

    override fun createComponent(): JComponent {
        tableModel = object : DefaultTableModel(arrayOf("Name", "Server URL", "Terminal URL"), 0) {
            override fun isCellEditable(row: Int, col: Int) = true
        }
        table = JBTable(tableModel)

        for (c in ConnectionManager.get().list()) {
            tableModel.addRow(arrayOf(c.name, c.serverUrl, c.terminalUrl))
        }

        val tableWithToolbar = ToolbarDecorator.createDecorator(table)
            .setAddAction { tableModel.addRow(arrayOf("New", "http://localhost:8403", "ws://localhost:8404")) }
            .setRemoveAction {
                val sel = table.selectedRow
                if (sel >= 0 && tableModel.rowCount > 1) tableModel.removeRow(sel)
            }
            .createPanel()

        activeNameField = JTextField(ConnectionManager.get().active().name)

        rootPanel = JPanel().apply {
            layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS)
            add(javax.swing.JLabel("Active connection name:"))
            add(activeNameField)
            add(javax.swing.Box.createVerticalStrut(8))
            add(javax.swing.JLabel("Saved connections:"))
            add(tableWithToolbar)
        }
        return rootPanel
    }

    override fun isModified(): Boolean {
        val current = collectFromTable()
        return current != ConnectionManager.get().list() ||
            activeNameField.text != ConnectionManager.get().active().name
    }

    override fun apply() {
        val list = collectFromTable()
        ConnectionManager.get().replaceAll(list, activeNameField.text.trim())
    }

    override fun reset() {
        tableModel.rowCount = 0
        for (c in ConnectionManager.get().list()) {
            tableModel.addRow(arrayOf(c.name, c.serverUrl, c.terminalUrl))
        }
        activeNameField.text = ConnectionManager.get().active().name
    }

    private fun collectFromTable(): List<ForgeConnection> = (0 until tableModel.rowCount).map { i ->
        ForgeConnection(
            name = (tableModel.getValueAt(i, 0) ?: "").toString().trim(),
            serverUrl = (tableModel.getValueAt(i, 1) ?: "").toString().trim(),
            terminalUrl = (tableModel.getValueAt(i, 2) ?: "").toString().trim(),
        )
    }.filter { it.name.isNotEmpty() }
}
