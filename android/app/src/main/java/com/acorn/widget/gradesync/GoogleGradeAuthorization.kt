package com.acorn.widget.gradesync

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import com.google.android.gms.auth.api.identity.AuthorizationClient
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope

interface GradeAuthorization {
    fun setForeground(foreground: Boolean)
    fun available(): Boolean
    fun authorize(interactive: Boolean, complete: (NativeAuthorizationResult) -> Unit)
    fun pickSheet(complete: (NativeAuthorizationResult) -> Unit)
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean
    fun clearToken(token: String)
    fun close()
}
/** Token has intentionally no JSON conversion or useful toString, and exists only in native memory. */
class NativeAuthorizationResult @JvmOverloads constructor(val token: String? = null, val error: String? = null, val pickedFileId: String? = null) {
    override fun toString() = "NativeAuthorizationResult(redacted)"
}

/** Official GIS authorization; no WebView OAuth, ID token, server code, refresh token or extra scopes. */
class GoogleGradeAuthorization @JvmOverloads constructor(
    private val activity: Activity,
    private val clientFactory: () -> AuthorizationClient = { Identity.getAuthorizationClient(activity) },
    private val servicesAvailable: () -> Boolean = { GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(activity) == ConnectionResult.SUCCESS },
    private val launch: (PendingIntent) -> Unit = { intent ->
        @Suppress("DEPRECATION")
        activity.startIntentSenderForResult(intent.intentSender, REQUEST_CODE, null, 0, 0, 0)
    }
) : GradeAuthorization {
    private var pending: ((NativeAuthorizationResult) -> Unit)? = null
    private var closed = false
    private var foreground = false
    private var resolution: PendingIntent? = null
    private var picking = false
    override fun setForeground(foreground: Boolean) {
        this.foreground = foreground
        if (foreground && !closed) resolution?.let { launchResolution(it) }
    }
    private fun launchResolution(intent: PendingIntent) {
        if (!foreground || closed || pending == null) return
        resolution = null
        try {
            launch(intent)
        } catch (_: Exception) { finish(NativeAuthorizationResult(error = "authorization-required")) }
    }
    private val client by lazy { clientFactory() }
    override fun available() = servicesAvailable()
    override fun authorize(interactive: Boolean, complete: (NativeAuthorizationResult) -> Unit) = request(interactive, false, complete)
    override fun pickSheet(complete: (NativeAuthorizationResult) -> Unit) = request(true, true, complete)
    private fun request(interactive: Boolean, picker: Boolean, complete: (NativeAuthorizationResult) -> Unit) {
        if (closed || !available()) { complete(NativeAuthorizationResult(error = "not-configured")); return }
        if (!foreground) { complete(NativeAuthorizationResult(error = "offline")); return }
        if (pending != null) { complete(NativeAuthorizationResult(error = "busy")); return }
        pending = complete
        picking = picker
        val builder = AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(DRIVE_FILE)))
            .setOptOutIncludingGrantedScopes(true)
        if (picker) builder.setPrompt(AuthorizationRequest.Prompt.CONSENT or AuthorizationRequest.Prompt.SELECT_ACCOUNT)
            .addResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_OAUTH_TRIGGER, "true")
            .addResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_ALLOW_MULTIPLE, "false")
            .addResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_ALLOW_FOLDER_SELECTION, "false")
            .addResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_MIMETYPES, "application/vnd.google-apps.spreadsheet")
        else if (interactive) builder.setPrompt(AuthorizationRequest.Prompt.SELECT_ACCOUNT)
        try { client.authorize(builder.build()).addOnSuccessListener { result ->
            if (closed || pending == null) return@addOnSuccessListener
            if (result.hasResolution()) {
                if (!interactive) finish(NativeAuthorizationResult(error = "authorization-required"))
                else try {
                    val intent = result.pendingIntent ?: error("authorization-required")
                    resolution = intent
                    launchResolution(intent)
                } catch (_: Exception) { finish(NativeAuthorizationResult(error = "authorization-required")) }
            } else accept(result)
        }.addOnFailureListener { error ->
            finish(NativeAuthorizationResult(error = if (error is ApiException && error.statusCode == 10) "not-configured" else "authorization-required"))
        } } catch (_: Exception) { finish(NativeAuthorizationResult(error = "authorization-required")) }
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        if (pending == null || closed) return true // A rotated/destroyed request cannot create a Sheet later.
        if (resultCode != Activity.RESULT_OK) { finish(NativeAuthorizationResult(error = "cancelled")); return true }
        try { accept(client.getAuthorizationResultFromIntent(data)) }
        catch (_: Exception) { finish(NativeAuthorizationResult(error = "authorization-required")) }
        return true
    }
    private fun accept(result: AuthorizationResult) {
        val token = result.accessToken
        if (result.hasResolution() || token.isNullOrBlank() || result.grantedScopes.none { it == DRIVE_FILE }) finish(NativeAuthorizationResult(error = "authorization-required"))
        else if (picking) {
            val selected = result.tokenResponseParams?.getString("picked_file_ids")
            if (selected == null || !selected.matches(Regex("[A-Za-z0-9_-]{1,200}"))) finish(NativeAuthorizationResult(error = "invalid-selection"))
            else finish(NativeAuthorizationResult(token = token, pickedFileId = selected))
        } else finish(NativeAuthorizationResult(token = token))
    }
    private fun finish(result: NativeAuthorizationResult) { val callback = pending; pending = null; resolution = null; picking = false; if (!closed) callback?.invoke(result) }
    override fun clearToken(token: String) {
        if (!closed && token.isNotBlank()) try { client.clearToken(ClearTokenRequest.builder().setToken(token).build()).addOnFailureListener { /* No sensitive diagnostics. */ } } catch (_: Exception) { /* No sensitive diagnostics. */ }
    }
    override fun close() { closed = true; pending = null; resolution = null; picking = false }
    companion object { const val DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"; const val REQUEST_CODE = 7419 }
}
