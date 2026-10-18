package com.acorn.widget.gradesync

import org.json.JSONObject
import java.security.MessageDigest

/** drive.file permits this exact metadata projection; no profile/email/OpenID grant is needed. */
object GradeAccountIdentity {
    const val PATH = "/drive/v3/about?fields=user(permissionId)"
    fun request() = SheetRequest("GET", PATH, null, "www.googleapis.com")
    fun fingerprint(deviceId: String, body: JSONObject): String {
        val permissionId = body.getJSONObject("user").opt("permissionId") as? String ?: error("authorization-required")
        require(permissionId.matches(Regex("[A-Za-z0-9_-]{1,256}"))) { "authorization-required" }
        // Installation salt prevents a portable public identifier; only this hash is encrypted on disk.
        return MessageDigest.getInstance("SHA-256").digest((deviceId + "\u0000" + permissionId).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
