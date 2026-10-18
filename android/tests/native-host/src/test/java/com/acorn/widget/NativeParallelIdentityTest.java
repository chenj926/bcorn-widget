package com.acorn.widget;

import static org.junit.Assert.*;
import android.appwidget.AppWidgetHostView;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.RemoteViews;
import java.io.File;
import java.nio.file.Files;
import java.time.LocalDate;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

/** Actual AGP identity and synthetic private-storage checks; not a two-app device install. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, qualifiers = "mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeParallelIdentityTest {
  private static final String APP = "com.bcorn.widget";

  @Test public void mergedApplicationIdentityIsSeparateWhileComponentClassesStayCompatible() throws Exception {
    Context context = RuntimeEnvironment.getApplication();
    assertEquals(APP, context.getPackageName());
    assertEquals("com.acorn.widget.MainActivity", MainActivity.class.getName());
    assertEquals("com.acorn.widget.TimetableWidgetProvider", TimetableWidgetProvider.class.getName());
    assertEquals(APP, context.getPackageManager().getActivityInfo(new android.content.ComponentName(context, MainActivity.class), 0).packageName);
    assertEquals(APP, context.getPackageManager().getReceiverInfo(new android.content.ComponentName(context, TimetableWidgetProvider.class), 0).packageName);
  }

  @Test public void realRemoteViewsAndExplicitPendingIntentsUseNewInstalledIdentity() throws Exception {
    Context context = RuntimeEnvironment.getApplication();
    RemoteViews views = TimetableWidgetProvider.Companion.createViews(context, 701, 350, 490, null, LocalDate.parse("2026-10-19"));
    assertEquals(APP, views.getPackage());
    View rendered = views.apply(context, new AppWidgetHostView(context));
    assertTrue(rendered.findViewById(R.id.widget_content).performClick());
    Intent launch = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
    assertNotNull(launch);
    assertEquals(APP, launch.getComponent().getPackageName());
    assertEquals(MainActivity.class.getName(), launch.getComponent().getClassName());
    int[] buttons = {R.id.widget_previous, R.id.widget_next, R.id.widget_today, R.id.widget_mode};
    for (int button : buttons) {
      assertTrue(rendered.findViewById(button).performClick());
      List<Intent> broadcasts = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getBroadcastIntents();
      Intent intent = broadcasts.get(broadcasts.size() - 1);
      assertEquals(APP, intent.getComponent().getPackageName());
      assertEquals(TimetableWidgetProvider.class.getName(), intent.getComponent().getClassName());
      assertTrue(intent.getAction().startsWith(APP + "."));
      assertEquals("bcorn-widget", intent.getData().getScheme());
      assertEquals(APP, intent.getData().getHost());
      assertFalse(intent.getDataString().contains("com.acorn.widget"));
    }
  }

  @Test public void legacyTimetablePayloadRoundTripsOnlyThroughNewAppPrivateStorage() throws Exception {
    Context context = RuntimeEnvironment.getApplication();
    JSONObject meeting = new JSONObject().put("code", "SYN101").put("day", 1).put("start", "09:00").put("end", "10:00")
        .put("location", "ROOM 101").put("address", "123 Synthetic Road").put("exdates", new JSONArray().put("2026-10-19"));
    JSONObject term = new JSONObject().put("id", "synthetic-legacy").put("start", "2026-09-01").put("end", "2026-12-31")
        .put("courses", new JSONArray().put(new JSONObject().put("code", "SYN101").put("status", "Waitlisted")))
        .put("meetings", new JSONArray().put(meeting));
    JSONObject legacy = new JSONObject().put("terms", new JSONArray().put(term));
    CacheStore.INSTANCE.save(context, legacy.toString());
    File saved = new File(context.getFilesDir(), "timetable.json");
    assertTrue(saved.isFile());
    assertEquals(context.getFilesDir().getCanonicalFile(), saved.getCanonicalFile().getParentFile());
    assertFalse(saved.getCanonicalPath().contains("/com.acorn.widget/"));
    JSONObject restored = CacheStore.INSTANCE.read(context).getJSONArray("terms").getJSONObject(0);
    JSONObject restoredMeeting = restored.getJSONArray("meetings").getJSONObject(0);
    assertEquals("ROOM 101", restoredMeeting.getString("location"));
    assertEquals("123 Synthetic Road", restoredMeeting.getString("address"));
    assertEquals("2026-10-19", restoredMeeting.getJSONArray("exdates").getString(0));
    assertEquals("Waitlisted", restored.getJSONArray("courses").getJSONObject(0).getString("status"));
    assertFalse(Files.readString(saved.toPath()).contains("/data/data/com.acorn.widget"));
    CacheStore.INSTANCE.clear(context);
  }
}
