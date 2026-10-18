package com.acorn.widget

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.time.LocalDate

/**
 * Each widget owns a mode and an optional absolute selected date. A null date follows today.
 * Switching modes preserves the date; navigation moves 1/7 days; Today preserves the mode.
 * Legacy string-valued Monday entries migrate on the next write without changing user data.
 * All transitions are atomic and disk-backed, independent of Activity or process lifetime.
 */
object WidgetWeekStore {
    enum class Mode(val value: String) { DAY("day"), WEEK("week") }
    data class State(val mode: Mode = Mode.WEEK, val selectedDate: LocalDate? = null) {
        fun date(today: LocalDate): LocalDate = selectedDate ?: today
    }
    private fun file(context: Context) = AtomicFile(File(context.filesDir, "widget-weeks.json"))
    private fun read(context: Context): JSONObject = try {
        val bytes = file(context).readFully()
        if (bytes.size > 64 * 1024) JSONObject() else JSONObject(bytes.toString(Charsets.UTF_8))
    } catch (_: Exception) { JSONObject() }
    private fun write(context: Context, value: JSONObject) {
        val target = file(context)
        val stream = target.startWrite()
        try { stream.write(value.toString().toByteArray(Charsets.UTF_8)); target.finishWrite(stream) }
        catch (error: Exception) { target.failWrite(stream); throw error }
    }
    private fun decode(raw: Any?): State {
        val mode = if (raw is JSONObject && raw.optString("mode") == Mode.DAY.value) Mode.DAY else Mode.WEEK
        val date = try {
            val value = if (raw is String) raw else (raw as? JSONObject)?.optString("date").orEmpty()
            LocalDate.parse(value).takeIf { it.year in 1900..9998 }
        } catch (_: Exception) { null }
        return State(mode, date)
    }
    private fun encode(state: State) = JSONObject().put("mode", state.mode.value).put("date", state.selectedDate?.toString() ?: JSONObject.NULL)
    @Synchronized private fun transition(context: Context, id: Int, change: (State) -> State): State {
        val data = read(context)
        val state = change(decode(data.opt(id.toString())))
        write(context, data.put(id.toString(), encode(state)))
        return state
    }
    fun monday(day: LocalDate): LocalDate = day.minusDays(day.dayOfWeek.value.toLong() - 1)
    @Synchronized fun state(context: Context, id: Int): State = decode(read(context).opt(id.toString()))
    fun selected(context: Context, id: Int): LocalDate? = state(context, id).selectedDate
    fun navigate(context: Context, id: Int, delta: Int, today: LocalDate): LocalDate {
        require(delta == -1 || delta == 1)
        return transition(context, id) { old ->
            val target = old.date(today).plusDays(delta.toLong() * if (old.mode == Mode.DAY) 1 else 7)
            require(target.year in 1900..9998)
            old.copy(selectedDate = target)
        }.selectedDate!!
    }
    fun toggleMode(context: Context, id: Int): State = transition(context, id) { old ->
        old.copy(mode = if (old.mode == Mode.DAY) Mode.WEEK else Mode.DAY)
    }
    fun followToday(context: Context, id: Int) { transition(context, id) { it.copy(selectedDate = null) } }
    @Synchronized fun remove(context: Context, ids: IntArray) {
        val value = read(context); ids.forEach { value.remove(it.toString()) }; write(context, value)
    }
    @Synchronized fun restore(context: Context, oldIds: IntArray, newIds: IntArray) {
        val value = read(context)
        val selections = oldIds.map { id -> value.opt(id.toString()) }
        oldIds.forEach { value.remove(it.toString()) }
        newIds.zip(selections).forEach { (id, raw) -> if (raw != null && raw != JSONObject.NULL) value.put(id.toString(), encode(decode(raw))) }
        write(context, value)
    }
}
