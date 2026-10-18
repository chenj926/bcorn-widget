package com.acorn.widget;

import static org.junit.Assert.*;
import android.Manifest;
import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.provider.CalendarContract;
import com.acorn.widget.calendar.*;
import java.util.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;

/** Exercises production ContentResolver adapter against a recording synthetic ContentProvider. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class AndroidCalendarProviderTest {
  public static class RecordingProvider extends ContentProvider {
    String marker="[bcorn-link:synthetic]";
    String description="Personal notes\n"+marker;
    ArrayList<ContentProviderOperation> batch;
    String deleteSelection; String[] deleteArgs;
    String calendarSelection;
    boolean deleted=false;
    public boolean onCreate(){return true;}
    public String getType(Uri uri){return null;}
    public Cursor query(Uri uri,String[] columns,String selection,String[] args,String order){
      MatrixCursor cursor=new MatrixCursor(columns);
      Map<String,Object> row=new HashMap<>();
      if(uri.getPath().startsWith("/calendars")){
        calendarSelection=selection;
        row.put("_id",7L);row.put("calendar_displayName","Device calendar");row.put("account_name","test@example.test");
        row.put("account_type","test");row.put("maxReminders",3);row.put("allowedReminders","0,1");
      }else{
        row.put("_id",55L);row.put("calendar_id",7L);row.put("description",description);row.put("deleted",deleted?1:0);
      }
      Object[] values=new Object[columns.length];for(int i=0;i<columns.length;i++)values[i]=row.get(columns[i]);cursor.addRow(values);return cursor;
    }
    public Uri insert(Uri uri,ContentValues values){return ContentUris.withAppendedId(uri,55);}
    public int update(Uri uri,ContentValues values,String selection,String[] args){return 1;}
    public int delete(Uri uri,String selection,String[] args){deleteSelection=selection;deleteArgs=args;return 1;}
    @Override public ContentProviderResult[] applyBatch(ArrayList<ContentProviderOperation> operations){
      batch=operations;
      ContentProviderResult[] results=new ContentProviderResult[operations.size()];
      for(int i=0;i<results.length;i++)results[i]=operations.get(i).isInsert()?new ContentProviderResult(ContentUris.withAppendedId(operations.get(i).getUri(),55)):new ContentProviderResult(1);
      return results;
    }
  }
  private RecordingProvider fake;
  private AndroidCalendarProvider adapter;
  @Before public void setup(){
    Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.READ_CALENDAR,Manifest.permission.WRITE_CALENDAR);
    fake=new RecordingProvider();fake.attachInfo(RuntimeEnvironment.getApplication(),null);
    ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY,fake);
    adapter=new AndroidCalendarProvider(RuntimeEnvironment.getApplication());
  }
  private CalendarWrite event(){return new CalendarWrite("Course","Details","Room",new CalendarOccurrence("once",1000,2000,"UTC"),Arrays.asList(10,30));}
  @Test public void onlyWritableCalendarsAreQueriedAndCapabilitiesExposed(){
    List<WritableCalendar> calendars=adapter.calendars();assertEquals(1,calendars.size());
    assertTrue(fake.calendarSelection.contains("calendar_access_level >= ?"));assertEquals(3,calendars.get(0).getMaxReminders());assertTrue(calendars.get(0).getReminderMethods().contains(1));
  }
  @Test public void ownershipRequiresExactLineCalendarAndNotDeleted(){
    assertTrue(adapter.isOwned(7,55,fake.marker));assertFalse(adapter.isOwned(8,55,fake.marker));
    fake.description="Text mentions "+fake.marker+" inline";assertFalse(adapter.isOwned(7,55,fake.marker));
    fake.description=fake.marker;fake.deleted=true;assertFalse(adapter.isOwned(7,55,fake.marker));
  }
  @Test public void insertAndRemindersUseOneBatchWithBackReferences(){
    assertEquals(55,adapter.write(7,null,fake.marker,event()));assertEquals(3,fake.batch.size());assertTrue(fake.batch.get(0).isInsert());
    assertEquals(CalendarContract.Events.CONTENT_URI,fake.batch.get(0).getUri());
    assertEquals(CalendarContract.Reminders.CONTENT_URI,fake.batch.get(1).getUri());
  }
  @Test public void updateAssertsOwnershipInSameBatchBeforeReplacingReminders(){
    assertEquals(55,adapter.write(7,55L,fake.marker,event()));assertEquals(5,fake.batch.size());
    assertTrue(fake.batch.get(0).isAssertQuery());assertTrue(fake.batch.get(1).isUpdate());assertTrue(fake.batch.get(2).isDelete());
  }
  @Test public void deletionPredicateProtectsReusedOrMovedRows(){
    adapter.remove(7,55,fake.marker);assertTrue(fake.deleteSelection.contains("description = ?"));assertEquals(fake.description,fake.deleteArgs[2]);
    fake.description="unrelated";try{adapter.remove(7,55,fake.marker);fail("Must refuse unrelated row");}catch(IllegalStateException expected){}
  }
  @Test public void revokedPermissionFailsBeforeProviderWrite(){
    Shadows.shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.WRITE_CALENDAR);
    assertFalse(adapter.hasPermission());try{adapter.write(7,null,fake.marker,event());fail("Permission required");}catch(SecurityException expected){}
    assertNull(fake.batch);
  }
}
