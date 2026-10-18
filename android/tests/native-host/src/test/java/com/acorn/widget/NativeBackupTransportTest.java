package com.acorn.widget;
import static org.junit.Assert.*;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;
import java.io.ByteArrayInputStream;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowToast;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class NativeBackupTransportTest {
  private void export(MainActivity activity, String text) throws Exception {
    Method method=MainActivity.class.getDeclaredMethod("chooseExport",String.class,JSONObject.class);method.setAccessible(true);
    method.invoke(activity,"synthetic-export",new JSONObject().put("filename","backup.json").put("content",text));
  }
  @Test public void completeEnvelopeLargerThanOldSingleStoreLimitReachesSystemSaveDialog() throws Exception {
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class).create().start().resume()) {
      String text=new JSONObject().put("format","bcorn-user-backup").put("backupVersion",1).put("timetable",new JSONObject().put("terms",new org.json.JSONArray())).put("gradebook",new JSONObject().put("schemaVersion",1).put("courses",new org.json.JSONArray())).put("preferences",new JSONObject()).toString()+" ".repeat(2*1024*1024);
      export(controller.get(),text);
      Intent intent=Shadows.shadowOf(controller.get()).getNextStartedActivityForResult().intent;
      assertEquals(Intent.ACTION_CREATE_DOCUMENT,intent.getAction());assertEquals("application/json",intent.getType());assertEquals("backup.json",intent.getStringExtra(Intent.EXTRA_TITLE));
    }
  }
  @Test public void exportOverFiveMiBIsRejectedBeforeOpeningDestination() throws Exception {
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class).create().start().resume()) {
      try {export(controller.get(),"{}"+" ".repeat(5*1024*1024));fail("oversize export accepted");}
      catch(InvocationTargetException error){assertTrue(error.getCause().getMessage().contains("5 MB"));}
      assertNull(Shadows.shadowOf(controller.get()).getNextStartedActivityForResult());
    }
  }
  @Test public void importTransportAllowsEnvelopeThenLeavesValidationAndConfirmationToRenderer() throws Exception {
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class).create().start().resume()) {
      MainActivity activity=controller.get();Uri uri=Uri.parse("content://synthetic.backup/complete");
      String text="{\"format\":\"bcorn-user-backup\",\"backupVersion\":1}"+" ".repeat(2*1024*1024);
      Shadows.shadowOf(activity.getContentResolver()).registerInputStream(uri,new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
      activity.onActivityResult(MainActivity.IMPORT,Activity.RESULT_OK,new Intent().setData(uri));
      String script=Shadows.shadowOf((WebView)activity.findViewById(R.id.web_content)).getLastEvaluatedJavascript();
      assertTrue(script.startsWith("readImport(new File("));assertTrue(script.contains("bcorn-user-backup"));
      assertFalse(script.contains("saveData("));
    }
  }
  @Test public void importOverFiveMiBStopsBeforeRendererReceivesIt() {
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class).create().start().resume()) {
      MainActivity activity=controller.get();Uri uri=Uri.parse("content://synthetic.backup/too-large");
      Shadows.shadowOf(activity.getContentResolver()).registerInputStream(uri,new ByteArrayInputStream(new byte[5*1024*1024+1]));
      activity.onActivityResult(MainActivity.IMPORT,Activity.RESULT_OK,new Intent().setData(uri));
      assertTrue(ShadowToast.getTextOfLatestToast().contains("5 MB"));
      assertNull(Shadows.shadowOf((WebView)activity.findViewById(R.id.web_content)).getLastEvaluatedJavascript());
    }
  }
}
