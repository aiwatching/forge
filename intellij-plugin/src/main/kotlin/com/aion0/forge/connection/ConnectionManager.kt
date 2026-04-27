package com.aion0.forge.connection

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.messages.Topic

data class ForgeConnection(
    var name: String = "Local",
    var serverUrl: String = "http://localhost:8403",
    var terminalUrl: String = "ws://localhost:8404",
)

data class ConnectionState(
    var connections: MutableList<ForgeConnection> = mutableListOf(
        ForgeConnection(),
    ),
    var activeName: String = "Local",
)

interface ConnectionListener {
    fun onConnectionChanged(active: ForgeConnection)

    companion object {
        val TOPIC: Topic<ConnectionListener> =
            Topic.create("Forge connection changed", ConnectionListener::class.java)
    }
}

/** Multi-connection registry, persisted to the application-level XML state.
 *  Mirrors the VSCode extension's `forge.connections` + `forge.activeConnection`. */
@Service
@State(name = "ForgeConnections", storages = [Storage("forge.xml")])
class ConnectionManager : PersistentStateComponent<ConnectionState> {
    private var state = ConnectionState()

    override fun getState(): ConnectionState = state

    override fun loadState(s: ConnectionState) {
        state = s
        if (state.connections.isEmpty()) state.connections = mutableListOf(ForgeConnection())
    }

    fun list(): List<ForgeConnection> = state.connections.toList()

    fun active(): ForgeConnection =
        state.connections.firstOrNull { it.name == state.activeName }
            ?: state.connections.first()

    fun setActive(name: String) {
        if (state.connections.none { it.name == name }) return
        state.activeName = name
        notifyChanged()
    }

    fun add(c: ForgeConnection) {
        require(state.connections.none { it.name == c.name }) {
            "A connection named \"${c.name}\" already exists"
        }
        state.connections.add(c)
        notifyChanged()
    }

    fun remove(name: String) {
        if (state.connections.size <= 1) return
        state.connections.removeAll { it.name == name }
        if (state.activeName == name) {
            state.activeName = state.connections.firstOrNull()?.name ?: "Local"
        }
        notifyChanged()
    }

    fun replaceAll(connections: List<ForgeConnection>, activeName: String) {
        if (connections.isEmpty()) return
        state.connections = connections.toMutableList()
        state.activeName = if (connections.any { it.name == activeName }) activeName
                           else connections.first().name
        notifyChanged()
    }

    private fun notifyChanged() {
        ApplicationManager.getApplication()
            .messageBus
            .syncPublisher(ConnectionListener.TOPIC)
            .onConnectionChanged(active())
    }

    companion object {
        @JvmStatic
        fun get(): ConnectionManager =
            ApplicationManager.getApplication().getService(ConnectionManager::class.java)
    }
}
