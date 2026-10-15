package io.bcorn.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Widget taps start an Activity directly (no background broadcast-to-activity trampoline). */
class WidgetLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Resolve the ID against the current private snapshot. Never trust a URL in a fill-in Intent; widgets only open in-app details.
        val id = intent.getStringExtra(EXTRA_COURSE_ID)
        val course = TimetableStore.snapshot(this).courses.firstOrNull { it.id == id }
        startActivity(Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (course != null) putExtra(EXTRA_COURSE_ID, course.id)
        })
        finish()
    }

    companion object {
        const val EXTRA_COURSE_ID = "io.bcorn.mobile.courseId"
    }
}
