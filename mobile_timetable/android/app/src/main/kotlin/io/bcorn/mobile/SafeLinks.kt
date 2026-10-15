package io.bcorn.mobile

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.util.Locale

/** Never interprets intent:// payloads, executable URLs, or arbitrary packages/extras. */
internal object SafeLinks {
    private val schemes = setOf("http", "https", "geo", "google.navigation", "amapuri", "iosamap", "androidamap", "maps")

    fun validatedUri(raw: String): Uri? {
        val value = raw.trim()
        if (value.isEmpty() || value.length > 4000 || value.any { it.code <= 32 || it.code == 127 }) return null
        return try {
            val uri = Uri.parse(value)
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
            if (scheme !in schemes) return null
            if (scheme == "http" || scheme == "https") {
                if (uri.host.isNullOrBlank() || uri.userInfo != null) return null
            }
            if (uri.schemeSpecificPart.isNullOrBlank()) return null
            uri.normalizeScheme()
        } catch (_: Exception) {
            null
        }
    }

    fun open(context: Context, raw: String): Boolean {
        val uri = validatedUri(raw) ?: return false
        return try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).apply {
                if (uri.scheme == "http" || uri.scheme == "https") addCategory(Intent.CATEGORY_BROWSABLE)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
            true
        } catch (_: ActivityNotFoundException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }
}
