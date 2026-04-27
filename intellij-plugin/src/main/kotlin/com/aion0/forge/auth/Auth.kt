package com.aion0.forge.auth

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service

/** Per-connection token storage backed by IntelliJ's PasswordSafe (system
 *  keychain on macOS, KWallet/libsecret on Linux, Windows Credential Manager
 *  on Windows). Key shape: `forge.token.<connectionName>`. */
@Service
class Auth {
    fun getToken(connectionName: String): String? =
        PasswordSafe.instance.getPassword(attrs(connectionName))

    fun setToken(connectionName: String, token: String) {
        PasswordSafe.instance.set(attrs(connectionName), Credentials("forge", token))
    }

    fun clearToken(connectionName: String) {
        PasswordSafe.instance.set(attrs(connectionName), null)
    }

    private fun attrs(name: String) = CredentialAttributes("forge.token.$name", "forge")

    companion object {
        @JvmStatic
        fun get(): Auth = ApplicationManager.getApplication().getService(Auth::class.java)
    }
}
