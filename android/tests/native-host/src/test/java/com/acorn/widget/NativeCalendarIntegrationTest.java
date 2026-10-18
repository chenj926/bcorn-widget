package com.acorn.widget;
import static org.junit.Assert.*;
import android.Manifest;
import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.Looper;
import android.provider.CalendarContract;
import android.webkit.WebView;
import java.util.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.*;

/** Actual JS-interface → Activity → serial writer → ContentResolver path, synthetic provider only. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class NativeCalendarIntegrationTest {
  public static class MemoryProvider extends ContentProvider {
    boolean calendarAvailable=true;long next=100;int eventInserts, eventUpdates;
    final Map<Long,ContentValues> events=new LinkedHashMap<>();
    final List<ContentValues> reminders=new ArrayList<>();
    public boolean onCreate(){return true;} public String getType(Uri uri){return null;}
    public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){
      if(projection==null)projection=new String[]{"_id"};MatrixCursor cursor=new MatrixCursor(projection);
      if(uri.getPath().startsWith("/calendars")){
        if(!calendarAvailable)return cursor;ContentValues row=new ContentValues();
        row.put("_id",7);row.put("calendar_displayName","Synthetic writable calendar");row.put("account_name","synthetic@example.test");row.put("account_type","test");row.put("maxReminders",3);row.put("allowedReminders","1");add(cursor,projection,row);return cursor;
      }
      for(Map.Entry<Long,ContentValues> entry:events.entrySet()) {
        ContentValues row=entry.getValue();
        if(uri.getPathSegments().size()>1 && !uri.getLastPathSegment().equals(entry.getKey().toString()))continue;
        if(selection!=null && args!=null){
          if(!row.getAsString("calendar_id").equals(args[0]))continue;
          if(selection.contains("LIKE") && !row.getAsString("description").contains(args[1].replace("%","")))continue;
          if(selection.contains("description =") && !row.getAsString("description").equals(args[1]))continue;
        }
        add(cursor,projection,row);
      }
      return cursor;
    }
    private void add(MatrixCursor cursor,String[] columns,ContentValues row){Object[] values=new Object[columns.length];for(int i=0;i<columns.length;i++)values[i]=row.get(columns[i]);cursor.addRow(values);}
    public Uri insert(Uri uri,ContentValues values){long id=next++;ContentValues row=new ContentValues(values);row.put("_id",id);
      if(uri.getPath().startsWith("/events")){row.put("deleted",0);events.put(id,row);eventInserts++;}else reminders.add(row);
      return ContentUris.withAppendedId(uri,id);
    }
    public int update(Uri uri,ContentValues values,String selection,String[] args){ContentValues row=events.get(ContentUris.parseId(uri));if(row==null)return 0;row.putAll(values);eventUpdates++;return 1;}
    public int delete(Uri uri,String selection,String[] args){
      if(uri.getPath().startsWith("/reminders")){int old=reminders.size();reminders.removeIf(row->row.getAsString("event_id").equals(args[0]));return old-reminders.size();}
      ContentValues row=events.get(Long.parseLong(args[0]));
      if(row==null || !row.getAsString("calendar_id").equals(args[1]) || !row.getAsString("description").equals(args[2]))return 0;
      events.remove(Long.parseLong(args[0]));return 1;
    }
  }
  private MainActivity activity;private ShadowWebView web;private int sequence;
  private void connect(MainActivity value){activity=value;web=Shadows.shadowOf((WebView)value.findViewById(R.id.web_content));}
  private JSONObject invoke(String method,JSONObject arguments) throws Exception {
    String id="integration-"+(++sequence);
    ((MainActivity.NativeBridge)web.getJavascriptInterface("AcornNative")).call(id,method,arguments==null?"null":arguments.toString());
    long end=System.nanoTime()+5_000_000_000L;
    String prefix="window.__acornNativeReply(\""+id+"\",";
    while(System.nanoTime()<end){
      Shadows.shadowOf(Looper.getMainLooper()).idle();String script=web.getLastEvaluatedJavascript();
      if(script!=null && script.startsWith(prefix)){
        JSONArray result=new JSONArray("["+script.substring(script.indexOf('(')+1,script.lastIndexOf(')'))+"]");
        assertTrue("Native bridge returned error: "+result.opt(2),result.isNull(2));return result.getJSONObject(1);
      }
      Thread.sleep(5);
    }
    fail("No native response for "+method);return null;
  }
  private JSONObject event(String id,int reminder) throws Exception{return new JSONObject().put("id",id).put("title","Synthetic course").put("timeZone","America/Toronto").put("start","2026-10-19T09:00").put("end","2026-10-19T10:00").put("reminders",new JSONArray().put(reminder));}
  @Test public void explicitPermissionSelectionIdempotentSaveRecreationAndRevocation() throws Exception {
    android.app.Application application=RuntimeEnvironment.getApplication();
    Shadows.shadowOf(application).denyPermissions(Manifest.permission.READ_CALENDAR,Manifest.permission.WRITE_CALENDAR);
    application.getSharedPreferences("calendar-links-v1",0).edit().clear().commit();
    MemoryProvider provider=new MemoryProvider();provider.attachInfo(application,null);ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY,provider);
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class).create().start().resume()) {
      connect(controller.get());assertNull(Shadows.shadowOf(activity).getLastRequestedPermission());
      assertFalse(invoke("calendarStatus",null).getBoolean("permissionGranted"));
      assertEquals("permissionRequired",invoke("syncCalendarEvent",event("first",10)).getString("code"));
      assertNull(Shadows.shadowOf(activity).getLastRequestedPermission());assertEquals(0,provider.events.size());
      ((MainActivity.NativeBridge)web.getJavascriptInterface("AcornNative")).call("permission-denial","requestCalendarPermission","null");
      ShadowActivity.PermissionsRequest request=Shadows.shadowOf(activity).getLastRequestedPermission();
      assertEquals(MainActivity.CALENDAR_PERMISSION,request.requestCode);assertEquals(2,request.requestedPermissions.length);
      activity.onRequestPermissionsResult(request.requestCode,request.requestedPermissions,new int[]{-1,-1});
      assertTrue(web.getLastEvaluatedJavascript().contains("permissionDenied"));
      assertNotNull(invoke("saveData",new JSONObject().put("terms",new JSONArray())));assertNotNull(CacheStore.INSTANCE.read(activity));
      // This is a simulated OS grant. No live device permission or account is touched.
      Shadows.shadowOf(application).grantPermissions(Manifest.permission.READ_CALENDAR,Manifest.permission.WRITE_CALENDAR);
      assertTrue(invoke("requestCalendarPermission",null).getBoolean("permissionGranted"));
      assertEquals(1,invoke("listCalendars",null).getJSONArray("calendars").length());
      assertEquals("calendarRequired",invoke("syncCalendarEvent",event("first",10)).getString("code"));
      assertTrue(invoke("selectCalendar",new JSONObject().put("calendarId",7)).getBoolean("ok"));
      assertEquals(1,invoke("syncCalendarEvent",event("first",10)).getInt("written"));
      long id=provider.events.keySet().iterator().next();
      assertEquals(1,invoke("syncCalendarEvent",event("first",10)).getInt("unchanged"));assertEquals(1,provider.eventInserts);
      assertEquals(1,invoke("syncCalendarEvent",event("second",5)).getInt("written"));assertEquals(2,provider.events.size());
      assertEquals(1,invoke("syncCalendarEvent",event("first",30)).getInt("written"));assertEquals(2,provider.events.size());assertTrue(provider.events.containsKey(id));
      assertTrue(provider.reminders.stream().anyMatch(row->row.getAsLong("event_id")==id && row.getAsInteger("minutes")==30));
      assertTrue(provider.reminders.stream().anyMatch(row->row.getAsLong("event_id")!=id && row.getAsInteger("minutes")==5));
      controller.recreate();connect(controller.get());assertEquals(1,invoke("syncCalendarEvent",event("first",30)).getInt("unchanged"));
      Shadows.shadowOf(application).denyPermissions(Manifest.permission.WRITE_CALENDAR);
      assertEquals("permissionRequired",invoke("syncCalendarEvent",event("first",15)).getString("code"));assertEquals(2,provider.events.size());
      Shadows.shadowOf(application).grantPermissions(Manifest.permission.WRITE_CALENDAR);provider.calendarAvailable=false;
      assertEquals("calendarRequired",invoke("syncCalendarEvent",event("first",15)).getString("code"));assertEquals(2,provider.events.size());
      Intent launched;
      while((launched=Shadows.shadowOf(application).getNextStartedActivity())!=null) assertNotEquals("No automatic ACTION_INSERT fallback",Intent.ACTION_INSERT,launched.getAction());
      assertNotNull(CacheStore.INSTANCE.read(activity));
    }
  }
}
