package com.acorn.widget;
import static org.junit.Assert.*;
import android.content.Intent;
import android.webkit.WebView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowWebView;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class NativeWidgetDeepLinkTest {
  private ShadowWebView loaded(MainActivity activity) {
    WebView view=activity.findViewById(R.id.web_content);
    ShadowWebView shadow=Shadows.shadowOf(view);
    shadow.getWebViewClient().onPageFinished(view,"https://"+MainActivity.HOST+"/src/renderer/index.html");
    return shadow;
  }
  @Test public void weekDeepLinkWaitsForPageThenSurvivesActivityRecreation() {
    Intent intent=new Intent(RuntimeEnvironment.getApplication(),MainActivity.class).putExtra("openTerm",true).putExtra("weekStart","2026-11-02");
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class,intent).create().start().resume()) {
      MainActivity activity=controller.get();ShadowWebView web=Shadows.shadowOf((WebView)activity.findViewById(R.id.web_content));
      assertNull(web.getLastEvaluatedJavascript());
      web=loaded(activity);assertTrue(web.getLastEvaluatedJavascript().contains("\"date\":\"2026-11-02\""));assertTrue(web.getLastEvaluatedJavascript().contains("\"mode\":\"week\""));assertTrue(web.getLastEvaluatedJavascript().contains("acornOpenWidgetWeek"));
      activity.onNewIntent(new Intent(activity,MainActivity.class).putExtra("weekStart","2026-11-09"));
      assertTrue(web.getLastEvaluatedJavascript().contains("2026-11-09"));
      assertEquals("2026-11-09",activity.getIntent().getStringExtra("weekStart"));
      // Reconstruct from the latest launch intent as Android's ActivityThread would.
      try(ActivityController<MainActivity> restored=Robolectric.buildActivity(MainActivity.class,activity.getIntent()).create().start().resume()) {
        web=loaded(restored.get());assertTrue(web.getLastEvaluatedJavascript().contains("2026-11-09"));
      }
    }
  }
  @Test public void selectedDayOverridesCompatibilityMondayAndSurvivesNewIntentAndReconstruction() {
    Intent intent=new Intent(RuntimeEnvironment.getApplication(),MainActivity.class).putExtra("openTerm",true).putExtra("weekStart","2026-11-02").putExtra("selectedDate","2026-11-05").putExtra("widgetMode","day");
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class,intent).create().start().resume()) {
      MainActivity activity=controller.get();ShadowWebView web=loaded(activity);
      assertTrue(web.getLastEvaluatedJavascript().contains("\"date\":\"2026-11-05\""));
      assertTrue(web.getLastEvaluatedJavascript().contains("\"mode\":\"day\""));
      assertFalse(web.getLastEvaluatedJavascript().contains("2026-11-02"));
      activity.onNewIntent(new Intent(activity,MainActivity.class).putExtra("selectedDate","2026-11-08").putExtra("widgetMode","week"));
      assertTrue(web.getLastEvaluatedJavascript().contains("\"date\":\"2026-11-08\""));
      assertTrue(web.getLastEvaluatedJavascript().contains("\"mode\":\"week\""));
      try(ActivityController<MainActivity> restored=Robolectric.buildActivity(MainActivity.class,activity.getIntent()).create().start().resume()) {
        web=loaded(restored.get());assertTrue(web.getLastEvaluatedJavascript().contains("\"date\":\"2026-11-08\""));
      }
    }
  }
  @Test public void malformedSelectedDateFallsBackToValidMondayAndUnknownModeToWeek() {
    for(String invalid:new String[]{"2026-99-05","0001-01-01","bad';alert(1)//"}) {
      Intent intent=new Intent(RuntimeEnvironment.getApplication(),MainActivity.class).putExtra("weekStart","2026-11-02").putExtra("selectedDate",invalid).putExtra("widgetMode","day");
      try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class,intent).create().start().resume()) {
        String script=loaded(controller.get()).getLastEvaluatedJavascript();
        assertTrue(script.contains("\"date\":\"2026-11-02\""));assertTrue(script.contains("\"mode\":\"week\""));assertFalse(script.contains(invalid));
      }
    }
    Intent intent=new Intent(RuntimeEnvironment.getApplication(),MainActivity.class).putExtra("selectedDate","2026-11-05").putExtra("widgetMode","invalid';alert(1)//");
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class,intent).create().start().resume()) {
      String script=loaded(controller.get()).getLastEvaluatedJavascript();assertTrue(script.contains("\"mode\":\"week\""));assertFalse(script.contains("alert"));
    }
  }
  @Test public void malformedOrOutOfRangeWeekCannotInjectJavascript() {
    for(String invalid:new String[]{"2026-11-03","0001-01-01","bad';alert(1)//"}) {
      Intent intent=new Intent(RuntimeEnvironment.getApplication(),MainActivity.class).putExtra("openTerm",true).putExtra("weekStart",invalid);
      try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class,intent).create().start().resume()) {
        ShadowWebView web=loaded(controller.get());
        assertFalse(web.getLastEvaluatedJavascript().contains("__acornWidgetWeek"));assertFalse(web.getLastEvaluatedJavascript().contains(invalid));
      }
    }
  }
}
