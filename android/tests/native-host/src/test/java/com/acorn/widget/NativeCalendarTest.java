package com.acorn.widget;

import static org.junit.Assert.*;
import android.content.Context;
import com.acorn.widget.calendar.*;
import java.time.Instant;
import java.util.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Synthetic provider only: never reads or writes the user's calendar. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class NativeCalendarTest {
  private Context context;
  private FakeProvider provider;
  private CalendarBridge bridge;
  private static class Row {
    long calendar; String marker; CalendarWrite event;
    Row(long c,String m,CalendarWrite e) {calendar=c;marker=m;event=e;}
  }
  private static class FakeProvider implements CalendarProvider {
    boolean permission=true, interruptAfterInsert=false;
    int writes=0, deletes=0; long next=100;
    List<WritableCalendar> targets=new ArrayList<>(Arrays.asList(new WritableCalendar(7,"School","student@example.test","test",3,Collections.singleton(1))));
    Map<Long,Row> rows=new HashMap<>();
    public boolean hasPermission(){return permission;}
    public List<WritableCalendar> calendars(){return targets;}
    public List<Long> findOwned(long c,String m){List<Long> ids=new ArrayList<>(); rows.forEach((id,r)->{if(r.calendar==c && r.marker.equals(m))ids.add(id);});return ids;}
    public boolean isOwned(long c,long id,String m){Row r=rows.get(id); return r!=null && r.calendar==c && r.marker.equals(m);}
    public long write(long c,Long id,String m,CalendarWrite e){
      long result=id==null?next++:id;
      if(id!=null && !isOwned(c,id,m))throw new IllegalStateException("not owned");
      rows.put(result,new Row(c,m,e)); writes++;
      if(interruptAfterInsert){interruptAfterInsert=false;throw new IllegalStateException("Synthetic interruption after provider commit");}
      return result;
    }
    public void remove(long c,long id,String m){if(!isOwned(c,id,m))throw new IllegalStateException("not owned");rows.remove(id);deletes++;}
  }
  @Before public void setup() throws Exception {
    context=RuntimeEnvironment.getApplication();
    context.getSharedPreferences("calendar-links-v1",0).edit().clear().commit();
    provider=new FakeProvider(); bridge=new CalendarBridge(context,provider);
  }
  private JSONObject call(String method,JSONObject input){return bridge.call(method,input);}
  private void choose() throws Exception {assertTrue(call("selectCalendar",new JSONObject().put("calendarId",7)).getBoolean("ok"));}
  private JSONObject once() throws Exception {return new JSONObject().put("id","event-A").put("title","Study")
      .put("timeZone","America/Toronto").put("start","2026-10-19T09:00").put("end","2026-10-19T10:00").put("reminders",new JSONArray().put(10));}
  private JSONObject recurring() throws Exception {return once().put("recurrence",new JSONObject()
      .put("startDate","2026-03-01").put("endDate","2026-03-15").put("weekdays",new JSONArray().put(7))
      .put("startTime","09:00").put("endTime","10:00").put("excludedDates",new JSONArray()));}
  @Test public void permissionRequiredNeverWrites() throws Exception {
    provider.permission=false; assertEquals("permissionRequired",call("syncCalendarEvent",once()).getString("code"));assertEquals(0,provider.writes);
  }
  @Test public void selectionIsExplicitAndRestrictedToWritableTargets() throws Exception {
    assertEquals("calendarRequired",call("syncCalendarEvent",once()).getString("code"));
    assertEquals("calendarUnavailable",call("selectCalendar",new JSONObject().put("calendarId",99)).getString("code"));
    assertEquals(1,call("listCalendars",new JSONObject()).getJSONArray("calendars").length());
  }
  @Test public void repeatedSaveIsIdempotentAndChangedSaveUpdatesSameId() throws Exception {
    choose(); assertTrue(call("syncCalendarEvent",once()).getBoolean("ok"));
    assertEquals(1,call("syncCalendarEvent",once()).getInt("unchanged")); assertEquals(1,provider.writes);
    assertTrue(call("syncCalendarEvent",once().put("title","Updated")).getBoolean("ok"));
    assertEquals(1,provider.rows.size()); assertEquals("Updated",provider.rows.get(100L).event.getTitle());
  }
  @Test public void bindingsSurviveFacadeRecreation() throws Exception {
    choose();call("syncCalendarEvent",once());bridge=new CalendarBridge(context,provider);
    assertEquals(1,call("syncCalendarEvent",once()).getInt("unchanged"));assertEquals(1,provider.rows.size());
  }
  @Test public void interruptedInsertRecoversMarkerWithoutDuplicate() throws Exception {
    choose();provider.interruptAfterInsert=true;assertFalse(call("syncCalendarEvent",once()).getBoolean("ok"));
    bridge=new CalendarBridge(context,provider); assertTrue(call("syncCalendarEvent",once()).getBoolean("ok"));assertEquals(1,provider.rows.size());
  }
  @Test public void reusedOrExternallyDeletedIdsAreNotOverwritten() throws Exception {
    choose();call("syncCalendarEvent",once());provider.rows.get(100L).marker="unrelated";
    assertEquals("linkConflict",call("syncCalendarEvent",once().put("title","change")).getString("code"));assertEquals(1,provider.writes);
    assertTrue(call("removeCalendarEvent",new JSONObject().put("id","event-A")).getBoolean("ok"));assertEquals(1,provider.rows.size());assertEquals(0,provider.deletes);
  }
  @Test public void duplicateOwnershipStopsRatherThanDeletingArbitraryRows() throws Exception {
    choose();provider.interruptAfterInsert=true;call("syncCalendarEvent",once());provider.rows.put(101L,provider.rows.get(100L));
    assertEquals("linkConflict",call("syncCalendarEvent",once()).getString("code"));assertEquals(2,provider.rows.size());
  }
  @Test public void unsupportedRemindersFailBeforeAnyEventWrite() throws Exception {
    choose();provider.targets.set(0,new WritableCalendar(7,"School","student@example.test","test",0,Collections.emptySet()));
    assertEquals("unsupportedReminders",call("syncCalendarEvent",once()).getString("code"));assertEquals(0,provider.writes);
  }
  @Test public void changedAccountAtSameCalendarIdRequiresReselection() throws Exception {
    choose();provider.targets.set(0,new WritableCalendar(7,"Other","other@example.test","test",3,Collections.singleton(1)));
    assertEquals("calendarChanged",call("syncCalendarEvent",once()).getString("code"));assertEquals(0,provider.writes);
  }
  @Test public void selectionChangeDoesNotSilentlyMoveAnExistingLink() throws Exception {
    choose();call("syncCalendarEvent",once());provider.targets.add(new WritableCalendar(8,"Second","student@example.test","test",3,Collections.singleton(1)));
    assertEquals("targetChanged",call("selectCalendar",new JSONObject().put("calendarId",8)).getString("code"));
    assertEquals(7,call("calendarStatus",new JSONObject()).getLong("selectedCalendarId"));
    assertEquals(1,call("syncCalendarEvent",once()).getInt("unchanged"));assertEquals(1,provider.rows.size());
    assertTrue(call("removeCalendarEvent",new JSONObject().put("id","event-A")).getBoolean("ok"));
    assertTrue(call("selectCalendar",new JSONObject().put("calendarId",8)).getBoolean("ok"));
  }
  @Test public void recurringCoursesKeepWallClockAcrossDst() throws Exception {
    List<CalendarOccurrence> occurrences=CalendarOccurrences.expand(recurring());assertEquals(3,occurrences.size());
    assertEquals(Instant.parse("2026-03-01T14:00:00Z").toEpochMilli(),occurrences.get(0).getStart());
    assertEquals(Instant.parse("2026-03-08T13:00:00Z").toEpochMilli(),occurrences.get(1).getStart());
  }
  @Test public void exclusionsDeleteOnlyThisSeriesLinkedOccurrence() throws Exception {
    choose();JSONObject event=recurring();call("syncCalendarEvent",event);
    provider.rows.put(999L,new Row(7,"unrelated",null));
    event.getJSONObject("recurrence").put("excludedDates",new JSONArray().put("2026-03-08"));
    assertEquals(1,call("syncCalendarEvent",event).getInt("removed"));assertEquals(3,provider.rows.size());assertTrue(provider.rows.containsKey(999L));
  }
  @Test public void dstGapIsSkippedForSeriesAndRejectedForOneOff() throws Exception {
    JSONObject event=recurring();event.getJSONObject("recurrence").put("startTime","02:30").put("endTime","03:30");
    assertEquals(2,CalendarOccurrences.expand(event).size());choose();
    assertEquals("invalidEvent",call("syncCalendarEvent",once().put("start","2026-03-08T02:30").put("end","2026-03-08T03:30")).getString("code"));
  }
  @Test public void autumnOverlapDeterministicallyUsesEarlierOffset() throws Exception {
    JSONObject event=once().put("start","2026-11-01T01:15").put("end","2026-11-01T01:45");
    assertEquals(Instant.parse("2026-11-01T05:15:00Z").toEpochMilli(),CalendarOccurrences.expand(event).get(0).getStart());
  }
  @Test public void midnightCourseEndsOnNextDayAndBoundsAreEnforced() throws Exception {
    JSONObject event=recurring();event.getJSONObject("recurrence").put("startTime","23:30").put("endTime","00:30");
    assertEquals(3600000L,CalendarOccurrences.expand(event).get(0).getEnd()-CalendarOccurrences.expand(event).get(0).getStart());
    choose();event.getJSONObject("recurrence").put("endDate","2030-01-01");assertEquals("invalidEvent",call("syncCalendarEvent",event).getString("code"));
  }
  @Test public void removeIsIdempotentAndPermissionRevocationPreservesLinks() throws Exception {
    choose();call("syncCalendarEvent",once());provider.permission=false;
    assertEquals("permissionRequired",call("removeCalendarEvent",new JSONObject().put("id","event-A")).getString("code"));assertEquals(1,provider.rows.size());
    provider.permission=true;assertTrue(call("removeCalendarEvent",new JSONObject().put("id","event-A")).getBoolean("ok"));
    assertEquals(0,call("removeCalendarEvent",new JSONObject().put("id","event-A")).getInt("removed"));assertEquals(0,provider.rows.size());
  }
  @Test public void explicitCanonicalOccurrencesUseStableDatesAndAllowEmptyReconciliation() throws Exception {
    choose();JSONObject input=once().put("occurrences",new JSONArray().put(new JSONObject().put("key","2026-10-19").put("startMillis",1792414800000L).put("endMillis",1792418400000L)));
    assertEquals(1,call("syncCalendarEvent",input).getInt("written"));
    input.getJSONArray("occurrences").getJSONObject(0).put("endMillis",1792422000000L);
    assertEquals(1,call("syncCalendarEvent",input).getInt("written"));assertEquals(1,provider.rows.size());
    input.put("occurrences",new JSONArray());assertEquals(1,call("syncCalendarEvent",input).getInt("removed"));assertEquals(0,provider.rows.size());
  }
  @Test public void duplicateExplicitDatesAndFractionalRemindersFailBeforeWrite() throws Exception {
    choose();JSONObject item=new JSONObject().put("key","2026-10-19").put("startMillis",1792414800000L).put("endMillis",1792418400000L);
    assertEquals("invalidEvent",call("syncCalendarEvent",once().put("occurrences",new JSONArray().put(item).put(item))).getString("code"));
    assertEquals("invalidEvent",call("syncCalendarEvent",once().put("reminders",new JSONArray().put(1.5))).getString("code"));assertEquals(0,provider.writes);
  }

}
