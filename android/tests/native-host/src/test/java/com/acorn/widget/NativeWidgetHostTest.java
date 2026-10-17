package com.acorn.widget;

import static org.junit.Assert.*;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetHostView;
import android.widget.RemoteViews;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Arrays;
import org.json.JSONObject;
import org.json.JSONArray;
import android.content.Context;
import android.content.Intent;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.os.Bundle;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.util.HashSet;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowAppWidgetManager;

/** Real provider/RemoteViews code on Robolectric Android 15, not an emulator/device test. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, qualifiers = "mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeWidgetHostTest {
  private Context context;
  private AppWidgetManager manager;
  private ShadowAppWidgetManager host;
  private static final String FIXTURE = "{\"fetchedAt\":\"2026-10-17T00:00:00Z\",\"terms\":[{\"id\":\"synthetic\",\"name\":\"SYNTHETIC TEST TERM\",\"start\":\"2020-01-01\",\"end\":\"2035-12-31\",\"courses\":[{\"code\":\"TEST101H1\",\"status\":\"Enrolled\"},{\"code\":\"TEST202H1\",\"status\":\"Waitlisted\"},{\"code\":\"TEST303H1\",\"status\":\"Enrolled\"}],\"meetings\":[{\"code\":\"TEST101H1\",\"day\":1,\"start\":\"09:00\",\"end\":\"11:00\",\"location\":\"TEST A\",\"kind\":\"LEC\"},{\"code\":\"TEST202H1\",\"day\":1,\"start\":\"10:00\",\"end\":\"12:00\",\"location\":\"TEST B\",\"kind\":\"TUT\"},{\"code\":\"TEST101H1\",\"day\":7,\"start\":\"08:30\",\"end\":\"10:00\",\"location\":\"TEST C\",\"kind\":\"PRA\"}]}]}";
  @Before public void setup() {
    context = RuntimeEnvironment.getApplication();
    manager = AppWidgetManager.getInstance(context);
    host = Shadows.shadowOf(manager);
    CacheStore.INSTANCE.clear(context);
  }
  private int widget() { return host.createWidget(TimetableWidgetProvider.class, R.layout.timetable_widget); }
  private View sized(int id, int width, int height) {
    Bundle options = new Bundle();
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width);
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width);
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height);
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, height);
    manager.updateAppWidgetOptions(id, options);
    new TimetableWidgetProvider().onAppWidgetOptionsChanged(context, manager, id, options);
    View view = host.getViewFor(id);
    assertNotNull(view);
    return view;
  }
  private Bitmap grid(View view) {
    ImageView image = view.findViewById(R.id.widget_grid);
    assertNotNull(image);
    assertTrue(image.getDrawable() instanceof BitmapDrawable);
    return ((BitmapDrawable)image.getDrawable()).getBitmap();
  }
  private void imageEvidence(View view, int width, int height, String name) throws Exception {
    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
    view.layout(0, 0, width, height);
    Bitmap bitmap = Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
    view.draw(new Canvas(bitmap));
    File output = new File(System.getProperty("evidence.dir", "build/screenshots"),name+".png");
    output.getParentFile().mkdirs();
    try(FileOutputStream stream = new FileOutputStream(output)) { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,stream)); }
    HashSet<Integer> colors = new HashSet<>();
    for(int y=0;y<height;y+=2) for(int x=0;x<width;x+=2) colors.add(bitmap.getPixel(x,y));
    assertTrue("Native rendered screenshot must contain multiple colors, found "+colors.size(),colors.size()>10);
    System.out.println("NATIVE_RENDER " + name + " host="+width+"x"+height+" grid="+grid(view).getWidth()+"x"+grid(view).getHeight()+" colors="+colors.size()+" file="+output.getAbsolutePath());
  }
  @Test public void emptyProviderUpdateInflatesRemoteViews() throws Exception {
    View view = host.getViewFor(widget());
    assertTrue(((TextView)view.findViewById(R.id.widget_hint)).getText().toString().contains("添加课程或日程"));
    assertNotNull(grid(view));
    assertEquals(View.GONE,view.findViewById(R.id.widget_placeholder).getVisibility());
    assertTrue(view.findViewById(R.id.widget_root).hasOnClickListeners());
    view.findViewById(R.id.widget_root).performClick();
    Intent launch=Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
    assertNotNull(launch);
    assertEquals(MainActivity.class.getName(),launch.getComponent().getClassName());
    assertTrue(launch.getBooleanExtra("openTerm",false));
    imageEvidence(view,350,490,"widget-empty");
  }
  @Test public void smallAndFiveBySevenResizeRendersBitmap() throws Exception {
    CacheStore.INSTANCE.save(context,FIXTURE);
    int id=widget();
    View small=sized(id,180,180);
    Bitmap smallBitmap=grid(small);
    assertTrue(smallBitmap.getWidth()<=180);
    assertTrue(smallBitmap.getHeight()<=180);
    assertTrue(smallBitmap.getAllocationByteCount()<1024*1024);
    imageEvidence(small,180,180,"widget-small");
    View large=sized(id,350,490);
    Bitmap largeBitmap=grid(large);
    assertTrue(largeBitmap.getWidth()>smallBitmap.getWidth());
    assertTrue(largeBitmap.getHeight()>smallBitmap.getHeight());
    assertTrue(largeBitmap.getAllocationByteCount()<1024*1024);
    String description=large.findViewById(R.id.widget_grid).getContentDescription().toString();
    assertTrue(description.contains("TEST101H1"));
    assertTrue(description.contains("候补 1"));
    assertTrue(description.contains("时间待定 1"));
    imageEvidence(large,350,490,"widget-5x7");
    // Separate presentation fixture: invented Mon–Fri schedule, no overlaps or personal data.
    JSONObject realistic=calendar("SYNTHETIC DEMO","America/Toronto","2026-09-01","2026-12-31");
    String[][] slots={{"ABC101","1","09:00","10:30","ROOM A"},{"DEF202","1","14:00","15:00","ROOM B"},{"GHI303","2","10:00","12:00","ROOM C"},{"JKL404","2","15:00","16:00","ROOM D"},{"MNO505","3","09:30","11:00","ROOM E"},{"PQR606","3","13:00","14:30","ROOM F"},{"STU707","4","11:00","12:30","ROOM G"},{"VWX808","4","15:00","17:00","ROOM H"},{"YZA909","5","10:00","11:30","ROOM I"},{"BCD110","5","14:00","15:30","ROOM J"}};
    for(String[] slot:slots) {
      realistic.getJSONArray("courses").put(new JSONObject().put("code",slot[0]).put("status","Enrolled"));
      realistic.getJSONArray("meetings").put(new JSONObject().put("code",slot[0]).put("day",Integer.parseInt(slot[1])).put("start",slot[2]).put("end",slot[3]).put("location",slot[4]).put("kind","LEC"));
    }
    JSONObject demoData=new JSONObject().put("terms",new JSONArray().put(realistic));
    View realisticHost=TimetableWidgetProvider.Companion.createViews(context,905,350,490,demoData,LocalDate.parse("2026-10-12")).apply(context,new AppWidgetHostView(context));
    assertTrue(realisticHost.findViewById(R.id.widget_grid).getContentDescription().toString().contains("ABC101"));
    imageEvidence(realisticHost,350,490,"widget-realistic-week");
    host.reconstructWidgetViewAsIfPhoneWasRotated(id);
    assertNotNull(grid(host.getViewFor(id)));
  }
  @Test public void newProviderAndFreshViewsReloadUpdatedDiskCache() throws Exception {
    CacheStore.INSTANCE.save(context,FIXTURE);
    int id=widget();
    CacheStore.INSTANCE.save(context,FIXTURE.replace("SYNTHETIC TEST TERM","RELOADED TERM"));
    host.setAlwaysRecreateViewsDuringUpdate(true);
    new TimetableWidgetProvider().onUpdate(context,manager,new int[]{id});
    View refreshed=host.getViewFor(id);
    assertTrue(((TextView)refreshed.findViewById(R.id.widget_title)).getText().toString().contains("RELOADED TERM"));
    CacheStore.INSTANCE.clear(context);
    new TimetableWidgetProvider().onUpdate(context,manager,new int[]{id});
    assertTrue(((TextView)host.getViewFor(id).findViewById(R.id.widget_hint)).getText().toString().contains("添加课程或日程"));
  }
  @Test public void onceExdatesBoundsAndWeekAdvanceAreRespected() throws Exception {
    JSONObject data=new JSONObject(FIXTURE);
    JSONObject term=data.getJSONArray("terms").getJSONObject(0);
    term.put("start","2026-10-01").put("end","2026-10-31");
    JSONObject weekly=new JSONObject("{\"code\":\"WEEKLY\",\"day\":1,\"start\":\"09:00\",\"end\":\"10:00\",\"from\":\"2026-10-05\",\"until\":\"2026-10-26\",\"exdates\":[\"2026-10-19\"]}");
    JSONObject once=new JSONObject("{\"code\":\"ONCE\",\"title\":\"SYNTHETIC ONE-OFF\",\"recurrence\":\"once\",\"date\":\"2026-10-13\",\"day\":2,\"start\":\"13:00\",\"end\":\"14:00\"}");
    assertTrue(TimetableWidgetProvider.Companion.occursOn(term,weekly,LocalDate.parse("2026-10-12")));
    assertFalse(TimetableWidgetProvider.Companion.occursOn(term,weekly,LocalDate.parse("2026-10-19")));
    assertFalse(TimetableWidgetProvider.Companion.occursOn(term,weekly,LocalDate.parse("2026-09-28")));
    assertFalse(TimetableWidgetProvider.Companion.occursOn(term,weekly,LocalDate.parse("2026-11-02")));
    assertTrue(TimetableWidgetProvider.Companion.occursOn(term,once,LocalDate.parse("2026-10-13")));
    assertFalse(TimetableWidgetProvider.Companion.occursOn(term,once,LocalDate.parse("2026-10-20")));
    term.put("meetings",new JSONArray().put(weekly).put(once));
    term.put("courses",new JSONArray().put(new JSONObject().put("code","WEEKLY")).put(new JSONObject().put("code","ONCE")));
    RemoteViews first=TimetableWidgetProvider.Companion.createViews(context,901,350,490,data,LocalDate.parse("2026-10-12"));
    View firstHost=first.apply(context,new AppWidgetHostView(context));
    String firstDescription=firstHost.findViewById(R.id.widget_grid).getContentDescription().toString();
    assertTrue(firstDescription.contains("WEEKLY"));
    assertTrue(firstDescription.contains("SYNTHETIC ONE-OFF"));
    RemoteViews next=TimetableWidgetProvider.Companion.createViews(context,901,350,490,data,LocalDate.parse("2026-10-19"));
    View nextHost=next.apply(context,new AppWidgetHostView(context));
    String nextDescription=nextHost.findViewById(R.id.widget_grid).getContentDescription().toString();
    assertFalse(nextDescription.contains("WEEKLY"));
    assertFalse(nextDescription.contains("SYNTHETIC ONE-OFF"));
    assertTrue("Known scheduled courses are not TBA merely because this week is excluded",nextDescription.contains("时间待定 0"));
    assertTrue(((TextView)nextHost.findViewById(R.id.widget_week)).getText().toString().contains("2026-10-19"));
    imageEvidence(firstHost,350,490,"widget-once-current-week");
    imageEvidence(nextHost,350,490,"widget-next-week-excluded");
  }
  @Test @Config(qualifiers="xxhdpi") public void highDensityBitmapFitsBinderBudget() throws Exception {
    RemoteViews views=TimetableWidgetProvider.Companion.createViews(context,902,600,800,new JSONObject(FIXTURE),LocalDate.parse("2026-10-12"));
    View applied=views.apply(context,new AppWidgetHostView(context));
    Bitmap bitmap=grid(applied);
    assertEquals(Bitmap.Config.RGB_565,bitmap.getConfig());
    assertTrue("Capped to less than one megabyte",bitmap.getAllocationByteCount()<1024*1024);
    assertTrue("Density-aware bitmap should exceed logical width",bitmap.getWidth()>584);
    System.out.println("HIGH_DENSITY_BITMAP "+bitmap.getWidth()+"x"+bitmap.getHeight()+" bytes="+bitmap.getAllocationByteCount());
  }
  private JSONObject calendar(String id,String zone,String start,String end) throws Exception {
    return new JSONObject().put("id",id).put("name",id).put("timezone",zone).put("start",start).put("end",end).put("courses",new JSONArray()).put("meetings",new JSONArray());
  }
  private void addOnce(JSONObject calendar,String code,String date,String start,String end) throws Exception {
    calendar.getJSONArray("courses").put(new JSONObject().put("code",code).put("type","event").put("title",code));
    calendar.getJSONArray("meetings").put(new JSONObject().put("code",code).put("title",code).put("recurrence","once").put("date",date).put("day",LocalDate.parse(date).getDayOfWeek().getValue()).put("start",start).put("end",end));
  }
  @Test public void shanghaiEventOverlaysTorontoWeekWithConvertedWeekday() throws Exception {
    JSONObject data=new JSONObject(FIXTURE);
    JSONObject primary=data.getJSONArray("terms").getJSONObject(0).put("timezone","America/Toronto");
    JSONObject personal=calendar("SYNTHETIC PERSONAL","Asia/Shanghai","2026-10-01","2026-10-31");
    addOnce(personal,"SHANGHAI EVENT","2026-10-13","09:00","10:00");
    data.getJSONArray("terms").put(personal);
    JSONObject model=TimetableWidgetProvider.Companion.weekModel(Arrays.asList(primary,personal),primary,LocalDate.parse("2026-10-12"),ZoneId.of("America/Toronto"));
    JSONObject event=null;
    for(JSONObject meeting:CacheStore.INSTANCE.objects(model.getJSONArray("meetings"))) if(meeting.optString("displayCode").equals("SHANGHAI EVENT")) event=meeting;
    assertNotNull(event);
    assertEquals(1,event.getInt("day"));
    assertEquals("2026-10-12",event.getString("date"));
    assertEquals("21:00",event.getString("start"));
    assertEquals("22:00",event.getString("end"));
    View applied=TimetableWidgetProvider.Companion.createViews(context,903,350,490,data,LocalDate.parse("2026-10-12")).apply(context,new AppWidgetHostView(context));
    String description=applied.findViewById(R.id.widget_grid).getContentDescription().toString();
    assertTrue(description.contains("SHANGHAI EVENT"));
    assertTrue(description.contains("21:00至22:00"));
    assertTrue(description.contains("TEST101H1"));
    imageEvidence(applied,350,490,"widget-cross-timezone-overlay");
  }
  @Test public void convertedMidnightEventSplitsIntoTwoDatedSegments() throws Exception {
    JSONObject primary=calendar("TORONTO","America/Toronto","2026-10-01","2026-10-31");
    JSONObject personal=calendar("SHANGHAI","Asia/Shanghai","2026-10-01","2026-10-31");
    addOnce(personal,"MIDNIGHT EVENT","2026-10-13","11:30","13:00");
    JSONObject model=TimetableWidgetProvider.Companion.weekModel(Arrays.asList(primary,personal),primary,LocalDate.parse("2026-10-12"),ZoneId.of("America/Toronto"));
    JSONArray meetings=model.getJSONArray("meetings");
    assertEquals(2,meetings.length());
    assertEquals("2026-10-12",meetings.getJSONObject(0).getString("date"));
    assertEquals("23:30",meetings.getJSONObject(0).getString("start"));
    assertEquals("24:00",meetings.getJSONObject(0).getString("end"));
    assertEquals("2026-10-13",meetings.getJSONObject(1).getString("date"));
    assertEquals("00:00",meetings.getJSONObject(1).getString("start"));
    assertEquals("01:00",meetings.getJSONObject(1).getString("end"));
    JSONObject data=new JSONObject().put("terms",new JSONArray().put(primary).put(personal));
    View applied=TimetableWidgetProvider.Companion.createViews(context,904,350,490,data,LocalDate.parse("2026-10-12")).apply(context,new AppWidgetHostView(context));
    String description=applied.findViewById(R.id.widget_grid).getContentDescription().toString();
    assertTrue(description.contains("23:30至24:00"));
    assertTrue(description.contains("00:00至01:00"));
    imageEvidence(applied,350,490,"widget-cross-midnight");
  }
  @Test public void dstGapWallTimeIsOmittedWithoutShiftingAppointment() throws Exception {
    JSONObject primary=calendar("TORONTO DST","America/Toronto","2026-03-01","2026-03-31");
    addOnce(primary,"NONEXISTENT TIME","2026-03-08","02:30","03:30");
    addOnce(primary,"VALID TIME","2026-03-08","04:00","05:00");
    JSONObject model=TimetableWidgetProvider.Companion.weekModel(Arrays.asList(primary),primary,LocalDate.parse("2026-03-02"),ZoneId.of("America/Toronto"));
    assertEquals(1,model.getJSONArray("meetings").length());
    assertEquals("VALID TIME",model.getJSONArray("meetings").getJSONObject(0).getString("displayCode"));
  }
  @Test @Config(qualifiers="land-mdpi") public void landscapeOptionsUseMaxWidthAndMinHeight() throws Exception {
    CacheStore.INSTANCE.save(context,FIXTURE);
    int id=widget();
    Bundle options=new Bundle();
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,180);
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,500);
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT,180);
    options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,490);
    manager.updateAppWidgetOptions(id,options);
    new TimetableWidgetProvider().onAppWidgetOptionsChanged(context,manager,id,options);
    Bitmap bitmap=grid(host.getViewFor(id));
    assertEquals(484,bitmap.getWidth());
    assertEquals(94,bitmap.getHeight());
  }
  @Test public void corruptedDiskCacheShowsRecoverableEmptyState() throws Exception {
    try(FileOutputStream stream=new FileOutputStream(new File(context.getFilesDir(),"timetable.json"))) {
      stream.write("{invalid synthetic cache".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    assertNull(CacheStore.INSTANCE.read(context));
    View view=host.getViewFor(widget());
    assertNotNull(grid(view));
    assertEquals(View.GONE,view.findViewById(R.id.widget_placeholder).getVisibility());
    assertTrue(((TextView)view.findViewById(R.id.widget_hint)).getText().toString().contains("添加课程或日程"));
  }
  @Test public void successfulRemoteViewsReapplyRestoresHiddenGrid() throws Exception {
    CacheStore.INSTANCE.save(context,FIXTURE);
    int id=widget();
    RemoteViews errorState=new RemoteViews(context.getPackageName(),R.layout.timetable_widget);
    errorState.setViewVisibility(R.id.widget_grid,View.GONE);
    errorState.setViewVisibility(R.id.widget_placeholder,View.VISIBLE);
    manager.updateAppWidget(id,errorState);
    View oldView=host.getViewFor(id);
    assertEquals(View.GONE,oldView.findViewById(R.id.widget_grid).getVisibility());
    assertEquals(View.VISIBLE,oldView.findViewById(R.id.widget_placeholder).getVisibility());
    new TimetableWidgetProvider().onUpdate(context,manager,new int[]{id});
    View restored=host.getViewFor(id);
    assertSame("Same-layout update must exercise RemoteViews.reapply",oldView,restored);
    assertEquals(View.VISIBLE,restored.findViewById(R.id.widget_grid).getVisibility());
    assertEquals(View.GONE,restored.findViewById(R.id.widget_placeholder).getVisibility());
    assertNotNull(grid(restored));
  }
  @Test public void separateJvmPersistenceRoundTrip() throws Exception {
    File cacheDir=new File(System.getProperty("process.cache.dir","/tmp/acorn-native-host-process-cache"));
    cacheDir.mkdirs();
    Context persistent=new ContextWrapper(context){@Override public File getFilesDir(){return cacheDir;}};
    if ("seed".equals(System.getProperty("test.phase"))) {
      CacheStore.INSTANCE.save(persistent,FIXTURE);
      assertTrue(new File(cacheDir,"timetable.json").isFile());
      System.out.println("PERSISTENCE_SEEDED separate JVM follow-up required");
    } else {
      assertNotNull("Previous JVM must have seeded synthetic cache",CacheStore.INSTANCE.read(persistent));
      int id=widget();
      new TimetableWidgetProvider().onUpdate(persistent,manager,new int[]{id});
      assertTrue(((TextView)host.getViewFor(id).findViewById(R.id.widget_title)).getText().toString().contains("SYNTHETIC TEST TERM"));
      System.out.println("PERSISTENCE_RELOADED_FROM_PREVIOUS_JVM");
    }
  }
}
