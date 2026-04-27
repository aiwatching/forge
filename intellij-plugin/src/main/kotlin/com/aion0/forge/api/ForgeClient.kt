package com.aion0.forge.api

import com.aion0.forge.auth.Auth
import com.aion0.forge.connection.ConnectionManager
import com.google.gson.Gson
import com.google.gson.JsonElement
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

data class ApiResult(
    val ok: Boolean,
    val status: Int,
    val data: JsonElement? = null,
    val error: String? = null,
)

/** Lightweight HTTP wrapper around forge's REST API. Uses java.net.http for
 *  zero extra deps; Gson is bundled in the IntelliJ Platform. */
@Service
class ForgeClient {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        // Force HTTP/1.1. forge's Next.js server doesn't always handle the
        // HTTP/2 upgrade probe cleanly, which manifests as
        // "http/1.1 header parser received no byte".
        .version(HttpClient.Version.HTTP_1_1)
        .build()
    private val gson = Gson()

    fun activeName(): String = ConnectionManager.get().active().name
    fun baseUrl(): String = ConnectionManager.get().active().serverUrl
    fun terminalUrl(): String = ConnectionManager.get().active().terminalUrl

    /** Verify password against the active connection's `/api/auth/verify`.
     *  On success, persists the returned token in PasswordSafe. */
    fun login(password: String): ApiResult {
        val body = gson.toJson(mapOf("password" to password))
        val req = HttpRequest.newBuilder(URI.create("${baseUrl()}/api/auth/verify"))
            .header("Content-Type", "application/json")
            .timeout(Duration.ofSeconds(10))
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()
        return runCatching {
            val res = http.send(req, HttpResponse.BodyHandlers.ofString())
            val parsed = res.body().takeIf { it.isNotEmpty() }?.let { gson.fromJson(it, JsonElement::class.java) }
            if (res.statusCode() in 200..299 && parsed?.asJsonObject?.get("token") != null) {
                val token = parsed.asJsonObject.get("token").asString
                Auth.get().setToken(activeName(), token)
                ApiResult(true, res.statusCode(), parsed)
            } else {
                val err = parsed?.asJsonObject?.get("error")?.asString ?: "HTTP ${res.statusCode()}"
                ApiResult(false, res.statusCode(), parsed, err)
            }
        }.getOrElse { ApiResult(false, 0, error = it.message ?: "network error") }
    }

    fun logout() {
        Auth.get().clearToken(activeName())
    }

    /** Quick liveness probe — does NOT require auth. */
    fun ping(): Boolean = runCatching {
        val req = HttpRequest.newBuilder(URI.create("${baseUrl()}/api/version"))
            .timeout(Duration.ofSeconds(2))
            .GET().build()
        http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode() in 200..299
    }.getOrDefault(false)

    /** Generic request — returns `ApiResult` with parsed JSON body. */
    fun request(path: String, method: String = "GET", body: Any? = null): ApiResult {
        val url = "${baseUrl()}$path"
        return runCatching {
            val token = Auth.get().getToken(activeName())
            val builder = HttpRequest.newBuilder(URI.create(url))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .timeout(Duration.ofSeconds(15))
            if (token != null) builder.header("X-Forge-Token", token)
            when (method.uppercase()) {
                "GET"    -> builder.GET()
                "DELETE" -> builder.DELETE()
                "POST"   -> builder.POST(jsonBody(body))
                "PUT"    -> builder.PUT(jsonBody(body))
                else     -> builder.method(method, jsonBody(body))
            }
            val res = http.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            val text = res.body()
            val data = if (text.isNullOrBlank()) null
                       else runCatching { gson.fromJson(text, JsonElement::class.java) }.getOrNull()
            if (res.statusCode() in 200..299) {
                ApiResult(true, res.statusCode(), data)
            } else {
                val err = data?.asJsonObject?.get("error")?.asString ?: "HTTP ${res.statusCode()}"
                ApiResult(false, res.statusCode(), data, "$err  ($method $url)")
            }
        }.getOrElse {
            ApiResult(false, 0, error = "${it.javaClass.simpleName}: ${it.message ?: "network error"}  ($method $url)")
        }
    }

    private fun jsonBody(body: Any?): HttpRequest.BodyPublisher =
        if (body == null) HttpRequest.BodyPublishers.noBody()
        else HttpRequest.BodyPublishers.ofString(gson.toJson(body))

    companion object {
        @JvmStatic
        fun get(): ForgeClient =
            ApplicationManager.getApplication().getService(ForgeClient::class.java)
    }
}
