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
  private static final String FIXTURE = "{\"fetchedAt\":\"2026-10-17T00:00:00Z\",\"terms\":[{\"id\":\"synthetic\",\"name\":\"SYNTHETIC TEST TERM\",\"start\":\"2020-01-01\",\"end\":\"2035-12-31\",\"courses\":[{\"code\":\"TEST101H1\",\"status\":\"Enrolled\"},{\"code\":\"TEST202H1\",\"status\":\"Waitlisted\"},{\"code\":\"TEST303H1\",\"status\":\"Enrolled\"}],\"meetings\":[{\"code\":\"TEST101H1\",\"day\":1,\"start\":\"09:00\",\"end\":\"11:00\",\"location\":\"ROOM WITH A LONG NAME\",\"kind\":\"LEC\"},{\"code\":\"TEST202H1\",\"day\":1,\"start\":\"10:00\",\"end\":\"12:00\",\"location\":\"ROOM B1234\",\"kind\":\"TUT\"},{\"code\":\"TEST101H1\",\"day\":7,\"start\":\"08:30\",\"end\":\"10:00\",\"location\":\"TEST C\",\"kind\":\"PRA\"}]}]}";
  @Before public void setup() {
    context = RuntimeEnvironment.getApplication();
    manager = AppWidgetManager.getInstance(context);
    host = Shadows.shadowOf(manager);
    CacheStore.INSTANCE.clear(context);
    new File(context.getFilesDir(), "widget-weeks.json").delete();
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
    assertEquals(WidgetWeekStore.INSTANCE.monday(LocalDate.now(ZoneId.of("America/Toronto"))).toString(),launch.getStringExtra("weekStart"));
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
    String[][] slots={{"ABC101","1","09:00","10:30","AB204"},{"DEF202","1","14:00","15:00","CD105"},{"GHI303","2","10:00","12:00","EF301"},{"JKL404","2","15:00","16:00","GH112"},{"MNO505","3","09:30","11:00","JK202"},{"PQR606","3","13:00","14:30","LM104"},{"STU707","4","11:00","12:30","NP305"},{"VWX808","4","15:00","17:00","QR108"},{"YZA909","5","10:00","11:30","ST203"},{"BCD110","5","14:00","15:30","UV110"}};
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
    assertTrue(nextHost.findViewById(R.id.widget_today).getContentDescription().toString().contains("2026-10-19"));
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
    assertEquals(488,bitmap.getWidth());
    assertEquals(120,bitmap.getHeight());
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
  private void clickNavigation(int id,int button,String action) {
    View view=host.getViewFor(id);
    assertTrue(view.findViewById(button).performClick());
    java.util.List<Intent> broadcasts=Shadows.shadowOf(RuntimeEnvironment.getApplication()).getBroadcastIntents();
    Intent sent=broadcasts.get(broadcasts.size()-1);
    assertEquals(action,sent.getAction());
    assertEquals(id,sent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,-1));
    assertEquals(TimetableWidgetProvider.class.getName(),sent.getComponent().getClassName());
    // Deliver the actual immutable PendingIntent through Android's registered receiver queue.
    Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    assertNull("Week navigation must not launch the Activity",Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
  }
  @Test public void realNavigationActionsAreIndependentDurableAndDoNotOpenApp() throws Exception {
    CacheStore.INSTANCE.save(context,FIXTURE);
    int first=widget(), second=widget();
    LocalDate today=LocalDate.now(ZoneId.of("America/Toronto"));
    LocalDate monday=WidgetWeekStore.INSTANCE.monday(today);
    clickNavigation(first,R.id.widget_next,TimetableWidgetProvider.ACTION_NEXT);
    assertEquals(today.plusWeeks(1),WidgetWeekStore.INSTANCE.selected(context,first));
    assertNull(WidgetWeekStore.INSTANCE.selected(context,second));
    clickNavigation(first,R.id.widget_next,TimetableWidgetProvider.ACTION_NEXT);
    assertEquals(today.plusWeeks(2),WidgetWeekStore.INSTANCE.selected(context,first));
    assertTrue(host.getViewFor(first).findViewById(R.id.widget_content).performClick());
    Intent opened=Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
    assertEquals(monday.plusWeeks(2).toString(),opened.getStringExtra("weekStart"));
    assertEquals(today.plusWeeks(2).toString(),opened.getStringExtra("selectedDate"));
    assertEquals("week",opened.getStringExtra("widgetMode"));
    clickNavigation(second,R.id.widget_previous,TimetableWidgetProvider.ACTION_PREVIOUS);
    assertEquals(today.minusWeeks(1),WidgetWeekStore.INSTANCE.selected(context,second));
    sized(first,500,300);
    host.reconstructWidgetViewAsIfPhoneWasRotated(first);
    new TimetableWidgetProvider().onUpdate(context,manager,new int[]{first});
    assertTrue(host.getViewFor(first).findViewById(R.id.widget_today).getContentDescription().toString().contains(monday.plusWeeks(2).toString()));
    clickNavigation(first,R.id.widget_today,TimetableWidgetProvider.ACTION_TODAY);
    assertNull(WidgetWeekStore.INSTANCE.selected(context,first));
    assertEquals(today.minusWeeks(1),WidgetWeekStore.INSTANCE.selected(context,second));
    View after=TimetableWidgetProvider.Companion.createViews(context,first,350,490,new JSONObject(FIXTURE),monday.plusWeeks(3)).apply(context,new AppWidgetHostView(context));
    assertTrue(after.findViewById(R.id.widget_today).getContentDescription().toString().contains(monday.plusWeeks(3).toString()));
  }
  @Test public void allFourControlsHave48DpNonOverlappingTargetsAtMinimumAndNormalSizes() throws Exception {
    CacheStore.INSTANCE.save(context,FIXTURE);
    int id=widget();
    for(int width:new int[]{160,180,203,204,260,350,500}) {
      int height=Math.max(150,width);
      View view=sized(id,width,height);
      view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));
      view.layout(0,0,width,height);
      int[] controls=width<204?new int[]{R.id.widget_previous_compact,R.id.widget_today_compact,R.id.widget_mode_compact,R.id.widget_next_compact}:new int[]{R.id.widget_previous,R.id.widget_today,R.id.widget_mode,R.id.widget_next};
      java.util.List<android.graphics.Rect> occupied=new java.util.ArrayList<>();
      for(int button:controls) {
        View target=view.findViewById(button);
        assertTrue("width "+width+" target "+button,target.getWidth()>=48);
        assertTrue("height "+height+" target "+button,target.getHeight()>=48);assertTrue(target.hasOnClickListeners());assertEquals(View.VISIBLE,target.getVisibility());
        android.graphics.Rect rect=new android.graphics.Rect(0,0,target.getWidth(),target.getHeight());
        ((android.view.ViewGroup)view).offsetDescendantRectToMyCoords(target,rect);
        assertTrue(rect.left>=6&&rect.right<=width-6);
        for(android.graphics.Rect other:occupied) assertFalse(android.graphics.Rect.intersects(rect,other));
        occupied.add(rect);
      }
      assertEquals(View.GONE,view.findViewById(R.id.widget_hint).getVisibility());
      assertEquals(width<204?96:48,view.findViewById(width<204?R.id.widget_header_compact:R.id.widget_header).getHeight());
      assertEquals(height-(width<204?108:60),grid(view).getHeight());
    }
  }
  @Test public void nativeDayToggleAndNavigationKeepEachInstanceIndependent() throws Exception {
    CacheStore.INSTANCE.save(context,FIXTURE);
    int first=widget(), second=widget();
    LocalDate today=LocalDate.now(ZoneId.of("America/Toronto"));
    View original=host.getViewFor(first);
    clickNavigation(first,R.id.widget_mode,TimetableWidgetProvider.ACTION_MODE);
    assertSame("Toggle updates the existing RemoteViews",original,host.getViewFor(first));
    assertEquals(WidgetWeekStore.Mode.DAY,WidgetWeekStore.INSTANCE.state(context,first).getMode());
    assertNull(WidgetWeekStore.INSTANCE.selected(context,first));
    assertEquals(WidgetWeekStore.Mode.WEEK,WidgetWeekStore.INSTANCE.state(context,second).getMode());
    clickNavigation(first,R.id.widget_next,TimetableWidgetProvider.ACTION_NEXT);
    assertEquals(today.plusDays(1),WidgetWeekStore.INSTANCE.selected(context,first));
    clickNavigation(first,R.id.widget_previous,TimetableWidgetProvider.ACTION_PREVIOUS);
    assertEquals(today,WidgetWeekStore.INSTANCE.selected(context,first));
    clickNavigation(first,R.id.widget_mode,TimetableWidgetProvider.ACTION_MODE);
    clickNavigation(first,R.id.widget_next,TimetableWidgetProvider.ACTION_NEXT);
    assertEquals(today.plusDays(7),WidgetWeekStore.INSTANCE.selected(context,first));
    sized(first,160,180);
    clickNavigation(first,R.id.widget_mode_compact,TimetableWidgetProvider.ACTION_MODE);
    assertEquals(today.plusDays(7),WidgetWeekStore.INSTANCE.selected(context,first));
    clickNavigation(first,R.id.widget_next_compact,TimetableWidgetProvider.ACTION_NEXT);
    assertEquals(today.plusDays(8),WidgetWeekStore.INSTANCE.selected(context,first));
    assertTrue(host.getViewFor(first).findViewById(R.id.widget_content).performClick());
    Intent opened=Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
    assertEquals(today.plusDays(8).toString(),opened.getStringExtra("selectedDate"));
    assertEquals(WidgetWeekStore.INSTANCE.monday(today.plusDays(8)).toString(),opened.getStringExtra("weekStart"));
    assertEquals("day",opened.getStringExtra("widgetMode"));
    clickNavigation(first,R.id.widget_today_compact,TimetableWidgetProvider.ACTION_TODAY);
    assertNull(WidgetWeekStore.INSTANCE.selected(context,first));
    assertEquals(WidgetWeekStore.Mode.DAY,WidgetWeekStore.INSTANCE.state(context,first).getMode());
    assertNull(WidgetWeekStore.INSTANCE.selected(context,second));
    host.reconstructWidgetViewAsIfPhoneWasRotated(first);
    new TimetableWidgetProvider().onUpdate(context,manager,new int[]{first});
    assertEquals("切换周",((TextView)host.getViewFor(first).findViewById(R.id.widget_mode_compact)).getText().toString());
  }
  @Test public void dayAgendaShowsOnlySelectedDateAndPreservesRoomTimeAndOverflow() throws Exception {
    JSONObject term=calendar("SYNTHETIC DAY","America/Toronto","2026-09-01","2026-10-01");
    addOnce(term,"MONDAY ONLY","2026-10-12","09:00","10:00");
    addOnce(term,"ABC101","2026-10-18","09:00","10:00");
    term.getJSONArray("courses").getJSONObject(1).remove("type");
    term.getJSONArray("courses").getJSONObject(1).put("title","Applied Systems");
    term.getJSONArray("meetings").getJSONObject(1).put("title","Sunday Exam");
    addOnce(term,"DEF202","2026-10-18","13:00","14:30");
    term.getJSONArray("courses").getJSONObject(2).remove("type");
    term.getJSONArray("courses").getJSONObject(2).put("title","Design Foundations");
    term.getJSONArray("meetings").getJSONObject(2).put("title","Sunday Lab");
    term.getJSONArray("meetings").getJSONObject(1).put("room","ROOM 204").put("location","LONG BUILDING ADDRESS");
    term.getJSONArray("meetings").getJSONObject(2).put("room","LAB B");
    term.put("holidays",new JSONArray().put(new JSONObject().put("id","holiday").put("title","Synthetic break").put("kind","holiday").put("start","2026-10-18").put("end","2026-10-18")));
    JSONObject data=new JSONObject().put("terms",new JSONArray().put(term));
    WidgetWeekStore.INSTANCE.toggleMode(context,910);
    WidgetWeekStore.INSTANCE.navigate(context,910,1,LocalDate.parse("2026-10-17"));
    View day=TimetableWidgetProvider.Companion.createViews(context,910,350,490,data,LocalDate.parse("2026-11-01")).apply(context,new AppWidgetHostView(context));
    String description=day.findViewById(R.id.widget_grid).getContentDescription().toString();
    assertTrue(description.contains("2026-10-18，日课表"));assertTrue(description.contains("ABC101 · Sunday Exam"));assertTrue(description.contains("DEF202 · Sunday Lab"));assertFalse(description.contains("Applied Systems"));assertFalse(description.contains("Design Foundations"));
    assertFalse(description.contains("MONDAY ONLY"));assertTrue(description.contains("ROOM 204"));assertFalse(description.contains("LONG BUILDING ADDRESS"));
    assertTrue(description.contains("09:00至10:00"));
    imageEvidence(day,350,490,"widget-day-room-time");
    View small=TimetableWidgetProvider.Companion.createViews(context,910,160,180,data,LocalDate.parse("2026-11-01")).apply(context,new AppWidgetHostView(context));
    imageEvidence(small,160,180,"widget-day-small-overflow");
    View minimum=TimetableWidgetProvider.Companion.createViews(context,910,160,150,data,LocalDate.parse("2026-11-01")).apply(context,new AppWidgetHostView(context));
    imageEvidence(minimum,160,150,"widget-day-minimum-overflow");
    for(int n=0;n<7;n++) addOnce(term,"EXTRA "+n,"2026-10-18","15:00","15:15");
    View busy=TimetableWidgetProvider.Companion.createViews(context,910,350,490,data,LocalDate.parse("2026-11-01")).apply(context,new AppWidgetHostView(context));
    imageEvidence(busy,350,490,"widget-day-busy-overflow");
    WidgetWeekStore.INSTANCE.toggleMode(context,910);
    RemoteViews week=TimetableWidgetProvider.Companion.createViews(context,910,350,490,data,LocalDate.parse("2026-11-01"));
    week.reapply(context,day);
    assertTrue(day.findViewById(R.id.widget_grid).getContentDescription().toString().contains("MONDAY ONLY"));
    assertEquals(LocalDate.parse("2026-10-18"),WidgetWeekStore.INSTANCE.selected(context,910));
  }
  @Test public void roomFormatterKeepsIdentifyingSuffixAtNormalAndOverlapWidths() throws Exception {
    android.graphics.Paint paint=new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
    paint.setTextSize(10f);paint.setFakeBoldText(true);
    java.util.List<String> lines=TimetableWidgetProvider.Companion.compactRoomLines("Very Long Building Name ROOM AB999",38f,text->paint.measureText(text));
    assertEquals(2,lines.size());assertEquals("AB999",lines.get(1));
    for(String line:lines) assertTrue(paint.measureText(line)<=38f);
    assertEquals(Arrays.asList("ZZ101"),TimetableWidgetProvider.Companion.compactRoomLines("ZZ101",38f,text->paint.measureText(text)));
    assertEquals("204",TimetableWidgetProvider.Companion.compactRoomLines("VeryLongBuildingPrefix204",30f,text->paint.measureText(text)).get(0));
    assertEquals("999",TimetableWidgetProvider.Companion.compactRoomLines("ROOM AB999",22f,text->paint.measureText(text)).get(1));
    // Actual font metrics for a 15-minute block must remain vertically inside its own rectangle.
    paint.setTextSize(7f);
    android.graphics.Paint.FontMetrics fm=paint.getFontMetrics();
    float baseline=TimetableWidgetProvider.Companion.centeredTextBaseline(10f,22f,fm.ascent,fm.descent);
    assertTrue(baseline+fm.ascent>=10f);assertTrue(baseline+fm.descent<=22f);
    JSONObject term=calendar("SYNTHETIC ROOM STRESS","America/Toronto","2026-10-01","2026-10-31");
    addOnce(term,"ABC101","2026-10-12","09:00","11:00");
    addOnce(term,"DEF202","2026-10-13","10:00","10:15");
    addOnce(term,"GHI303","2026-10-14","11:00","12:00");
    addOnce(term,"JKL404","2026-10-14","11:15","12:15");
    for(JSONObject course:CacheStore.INSTANCE.objects(term.getJSONArray("courses"))) { course.remove("type");course.put("title","Applied Systems"); }
    for(JSONObject meeting:CacheStore.INSTANCE.objects(term.getJSONArray("meetings"))) meeting.put("room","Very Long Building Name ROOM AB999");
    JSONObject data=new JSONObject().put("terms",new JSONArray().put(term));
    View view=TimetableWidgetProvider.Companion.createViews(context,912,350,490,data,LocalDate.parse("2026-10-12")).apply(context,new AppWidgetHostView(context));
    assertTrue(view.findViewById(R.id.widget_grid).getContentDescription().toString().contains("AB999"));
    imageEvidence(view,350,490,"widget-room-number-stress");
  }
  @Test public void legacyWeekStateMigratesAndRestorePreservesDayModeWithoutIdCollisions() throws Exception {
    java.nio.file.Files.writeString(new File(context.getFilesDir(),"widget-weeks.json").toPath(),"{\"20\":\"2026-10-12\",\"21\":{\"mode\":\"day\",\"date\":\"2026-10-15\"}}");
    assertEquals(WidgetWeekStore.Mode.WEEK,WidgetWeekStore.INSTANCE.state(context,20).getMode());
    assertEquals(LocalDate.parse("2026-10-12"),WidgetWeekStore.INSTANCE.selected(context,20));
    WidgetWeekStore.INSTANCE.toggleMode(context,20);
    assertEquals(LocalDate.parse("2026-10-12"),WidgetWeekStore.INSTANCE.selected(context,20));
    WidgetWeekStore.INSTANCE.restore(context,new int[]{20,21},new int[]{21,22});
    assertNull(WidgetWeekStore.INSTANCE.selected(context,20));
    assertEquals(LocalDate.parse("2026-10-12"),WidgetWeekStore.INSTANCE.selected(context,21));
    assertEquals(LocalDate.parse("2026-10-15"),WidgetWeekStore.INSTANCE.selected(context,22));
    assertEquals(WidgetWeekStore.Mode.DAY,WidgetWeekStore.INSTANCE.state(context,22).getMode());
    JSONObject persisted=new JSONObject(java.nio.file.Files.readString(new File(context.getFilesDir(),"widget-weeks.json").toPath()));
    assertTrue(persisted.get("21") instanceof JSONObject);
  }
  @Test public void deletedAndRestoredWidgetIdsCannotLeakBrowsingSelection() {
    int id=widget(), replacement=widget();
    WidgetWeekStore.INSTANCE.navigate(context,id,1,LocalDate.parse("2026-10-12"));
    new TimetableWidgetProvider().onRestored(context,new int[]{id},new int[]{replacement});
    assertNull(WidgetWeekStore.INSTANCE.selected(context,id));
    assertEquals(LocalDate.parse("2026-10-19"),WidgetWeekStore.INSTANCE.selected(context,replacement));
    new TimetableWidgetProvider().onDeleted(context,new int[]{replacement});
    assertNull(WidgetWeekStore.INSTANCE.selected(context,replacement));
    new TimetableWidgetProvider().onReceive(context,new Intent(context,TimetableWidgetProvider.class).setAction(TimetableWidgetProvider.ACTION_NEXT).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,99999));
    assertNull(WidgetWeekStore.INSTANCE.selected(context,99999));
  }
  @Test public void onceOutsideTermAndHolidayRemainVisibleWithCustomColors() throws Exception {
    JSONObject term=calendar("TERM","America/Toronto","2026-09-01","2026-10-01");
    term.getJSONArray("courses").put(new JSONObject().put("code","SYNTH101").put("color","#336699"));
    term.getJSONArray("meetings").put(new JSONObject().put("id","special-1").put("code","SYNTH101").put("title","SUNDAY EXAM").put("recurrence","once").put("date","2026-10-18").put("day",7).put("start","09:00").put("end","10:00").put("location","ROOM X").put("color","#CC3366"));
    term.put("holidays",new JSONArray().put(new JSONObject().put("id","break-1").put("title","Synthetic break").put("kind","school-break").put("start","2026-10-18").put("end","2026-10-18")));
    JSONObject data=new JSONObject().put("terms",new JSONArray().put(term));
    CacheStore.INSTANCE.save(context,data.toString());
    assertTrue(TimetableWidgetProvider.Companion.occursOn(term,term.getJSONArray("meetings").getJSONObject(0),LocalDate.parse("2026-10-18")));
    View view=TimetableWidgetProvider.Companion.createViews(context,909,350,490,data,LocalDate.parse("2026-10-12")).apply(context,new AppWidgetHostView(context));
    String description=view.findViewById(R.id.widget_grid).getContentDescription().toString();
    assertTrue(description.contains("SUNDAY EXAM"));assertTrue(description.contains("ROOM X"));
    Bitmap bitmap=grid(view);
    assertNotEquals("Sunday card must occupy the seventh column",bitmap.getPixel(265,50),bitmap.getPixel(320,50));
    imageEvidence(view,350,490,"widget-seven-days-holiday-once-color");
    View small=TimetableWidgetProvider.Companion.createViews(context,909,180,180,data,LocalDate.parse("2026-10-12")).apply(context,new AppWidgetHostView(context));
    imageEvidence(small,180,180,"widget-small-sunday");
  }
  @Test public void separateJvmPersistenceRoundTrip() throws Exception {
    File cacheDir=new File(System.getProperty("process.cache.dir","/tmp/acorn-native-host-process-cache"));
    cacheDir.mkdirs();
    Context persistent=new ContextWrapper(context){@Override public File getFilesDir(){return cacheDir;}};
    if ("seed".equals(System.getProperty("test.phase"))) {
      CacheStore.INSTANCE.save(persistent,FIXTURE);
      WidgetWeekStore.INSTANCE.navigate(persistent,777,1,LocalDate.parse("2026-10-26"));
      WidgetWeekStore.INSTANCE.toggleMode(persistent,778);
      WidgetWeekStore.INSTANCE.navigate(persistent,778,1,LocalDate.parse("2026-10-28"));
      WidgetWeekStore.INSTANCE.toggleMode(persistent,779);
      WidgetWeekStore.INSTANCE.followToday(persistent,779);
      assertTrue(new File(cacheDir,"timetable.json").isFile());
      System.out.println("PERSISTENCE_SEEDED separate JVM follow-up required");
    } else {
      assertNotNull("Previous JVM must have seeded synthetic cache",CacheStore.INSTANCE.read(persistent));
      assertEquals(LocalDate.parse("2026-11-02"),WidgetWeekStore.INSTANCE.selected(persistent,777));
      assertEquals(WidgetWeekStore.Mode.DAY,WidgetWeekStore.INSTANCE.state(persistent,778).getMode());
      assertEquals(LocalDate.parse("2026-10-29"),WidgetWeekStore.INSTANCE.selected(persistent,778));
      assertEquals(WidgetWeekStore.Mode.DAY,WidgetWeekStore.INSTANCE.state(persistent,779).getMode());
      assertNull(WidgetWeekStore.INSTANCE.selected(persistent,779));
      View browsed=TimetableWidgetProvider.Companion.createViews(persistent,777,350,490,CacheStore.INSTANCE.read(persistent),LocalDate.parse("2027-01-04")).apply(persistent,new AppWidgetHostView(persistent));
      assertTrue(browsed.findViewById(R.id.widget_today).getContentDescription().toString().contains("2026-11-02"));
      int id=widget();
      new TimetableWidgetProvider().onUpdate(persistent,manager,new int[]{id});
      assertTrue(((TextView)host.getViewFor(id).findViewById(R.id.widget_title)).getText().toString().contains("SYNTHETIC TEST TERM"));
      System.out.println("PERSISTENCE_RELOADED_FROM_PREVIOUS_JVM");
    }
  }
}
