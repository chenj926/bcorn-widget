package com.acorn.widget.gradesync

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface GradeSyncStorage {
    fun deviceId(): String
    fun binding(): GradeSheetBinding?
    fun bind(binding: GradeSheetBinding)
    fun authorizationBlocked(): Boolean
    fun blockAuthorization()
    fun load(connectionId: String): JSONObject?
    fun save(connectionId: String, envelope: JSONObject)
}

/** No exported files, Android backup, account names/emails or OAuth tokens. A salted account fingerprint stays encrypted. SDK owns its token cache. */
class EncryptedGradeSyncStorage(context: Context, private val cipher: GradeStateCipher = AndroidGradeStateCipher()) : GradeSyncStorage {
    private val directory = File(context.noBackupFilesDir, "grade-sync-v1").apply { check(exists() || mkdirs()) }
    @Volatile private var device: String? = null
    @Volatile private var metadataLoaded = false
    @Volatile private var metadata: JSONObject? = null
    private fun metadata(): JSONObject? {
        if (!metadataLoaded) synchronized(this) {
            if (!metadataLoaded) { metadata = read("binding"); metadataLoaded = true }
        }
        return metadata
    }
    override fun deviceId(): String {
        device?.let { return it }
        return synchronized(this) {
            device?.let { return@synchronized it }
            val saved = read("device")?.optString("id")
            if (saved != null && saved.matches(Regex("[a-f0-9-]{36}"))) { device = saved; return@synchronized saved }
            val id = UUID.randomUUID().toString(); write("device", JSONObject().put("id", id)); device = id; id
        }
    }
    override fun binding(): GradeSheetBinding? = metadata()?.let { GradeSheetBinding.parse(it) }
    @Synchronized override fun bind(binding: GradeSheetBinding) {
        val next = binding.storedJson().put("authorizationBlocked", false)
        write("binding", next); metadata = next; metadataLoaded = true
    }
    override fun authorizationBlocked() = metadata()?.optBoolean("authorizationBlocked", false) ?: false
    @Synchronized override fun blockAuthorization() { metadata()?.let {
        val next = JSONObject(it.toString()).put("authorizationBlocked", true)
        write("binding", next); metadata = next
    } }
    @Synchronized override fun load(connectionId: String): JSONObject? {
        requireCurrent(connectionId)
        return read("journal-$connectionId")?.also { GradeSyncEnvelope.validate(it) }
    }
    @Synchronized override fun save(connectionId: String, envelope: JSONObject) {
        requireCurrent(connectionId); GradeSyncEnvelope.validate(envelope); write("journal-$connectionId", envelope)
    }
    private fun requireCurrent(id: String) { require(id.matches(Regex("[a-f0-9-]{36}")) && binding()?.connectionId == id) { "connection-changed" } }
    private fun file(name: String) = AtomicFile(File(directory, "$name.bin"))
    private fun read(name: String): JSONObject? {
        val file = file(name)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        require(listOf(file.baseFile, File(file.baseFile.path + ".bak")).all { it.length() <= GradeSheetsPolicy.MAX_BYTES + 1024 }) { "limit-exceeded" }
        val bytes = file.readFully()
        require(bytes.size <= GradeSheetsPolicy.MAX_BYTES + 1024) { "limit-exceeded" }
        return JSONObject(cipher.decrypt(name, bytes).toString(Charsets.UTF_8))
    }
    private fun write(name: String, json: JSONObject) {
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= GradeSheetsPolicy.MAX_BYTES) { "limit-exceeded" }
        val encrypted = cipher.encrypt(name, bytes)
        val file = file(name); val stream = file.startWrite()
        try { stream.write(encrypted); file.finishWrite(stream) } catch (error: Exception) { file.failWrite(stream); throw error }
    }
    companion object {
        private var shared: EncryptedGradeSyncStorage? = null
        /** One process-wide metadata owner prevents stale Activity instances from switching journals. */
        @Synchronized fun shared(context: Context): EncryptedGradeSyncStorage = shared ?: EncryptedGradeSyncStorage(context.applicationContext).also { shared = it }
    }

}

interface GradeStateCipher { fun encrypt(context: String, bytes: ByteArray): ByteArray; fun decrypt(context: String, bytes: ByteArray): ByteArray }
/** GCM authenticates the file purpose too: swapping connections/files cannot move a saved outbox. */
class AndroidGradeStateCipher @JvmOverloads constructor(private val keySource: (() -> SecretKey)? = null) : GradeStateCipher {
    private fun key(): SecretKey {
        keySource?.let { return it() }
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    override fun encrypt(context: String, bytes: ByteArray): ByteArray = synchronized(LOCK) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(context.toByteArray(Charsets.UTF_8))
        byteArrayOf(1) + cipher.iv + cipher.doFinal(bytes)
    }
    override fun decrypt(context: String, bytes: ByteArray): ByteArray = synchronized(LOCK) {
        require(bytes.size >= 29 && bytes[0] == 1.toByte()) { "invalid-storage" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(context.toByteArray(Charsets.UTF_8)); cipher.doFinal(bytes.copyOfRange(13, bytes.size))
    }
    companion object { private const val ALIAS = "bcorn.grade-sync.v1"; private val LOCK = Any() }
}

object GradeSyncEnvelope {
    fun validate(envelope: JSONObject) {
        require(envelope.toString().toByteArray(Charsets.UTF_8).size <= GradeSheetsPolicy.MAX_BYTES) { "limit-exceeded" }
        GradeSheetsPolicy.keys(envelope, setOf("schemaVersion", "coordinator", "publishedBook"))
        require(envelope.opt("schemaVersion") is Number && envelope.getDouble("schemaVersion") == 1.0 && envelope.opt("coordinator") is JSONObject && envelope.opt("publishedBook") is JSONObject) { "invalid-storage" }
        val coordinator = envelope.getJSONObject("coordinator")
        GradeSheetsPolicy.keys(coordinator, setOf("schemaVersion", "records", "base", "outbox", "conflicts", "sequence", "status", "lastSyncedAt", "retryAt", "automaticInbound", "authorizationBlocked", "retryAttempts", "error"))
        require(coordinator.optInt("schemaVersion") == 1 && listOf("records", "base", "outbox", "conflicts").all { coordinator.opt(it) is JSONObject }) { "invalid-storage" }
        val book = envelope.getJSONObject("publishedBook")
        GradeSheetsPolicy.keys(book, setOf("schemaVersion", "courses"))
        require(book.optInt("schemaVersion") == 1 && book.opt("courses") is JSONArray) { "invalid-storage" }
        checkJson(envelope, 0)
    }
    private fun checkJson(value: Any?, depth: Int) {
        require(depth <= 30) { "invalid-storage" }
        when (value) {
            is JSONObject -> value.keys().asSequence().forEach {
                require(it.length <= 1000 && it !in setOf("__proto__", "prototype", "constructor") && !Regex("(?i)(access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential|serverAuthCode)").containsMatchIn(it)) { "invalid-storage" }
                checkJson(value.get(it), depth + 1)
            }
            is JSONArray -> { require(value.length() <= 10000); for (i in 0 until value.length()) checkJson(value.get(i), depth + 1) }
            is Number -> require(value.toDouble().isFinite())
            is String, is Boolean, JSONObject.NULL, null -> Unit
            else -> error("invalid-storage")
        }
    }
}
