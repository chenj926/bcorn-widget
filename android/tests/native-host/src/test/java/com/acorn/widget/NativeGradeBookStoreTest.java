package com.acorn.widget;
import static org.junit.Assert.*;
import android.content.Context;
import org.json.*;
import java.io.File;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class NativeGradeBookStoreTest {
  private Context context;
  @Before public void setup(){context=RuntimeEnvironment.getApplication();new File(context.getFilesDir(),"grades-v1.json").delete();}
  private JSONObject book() throws Exception{return new JSONObject("{\"schemaVersion\":1,\"courses\":[{\"id\":\"course-A\",\"title\":\"SYNTHETIC\",\"termId\":\"fall\",\"rules\":{\"kind\":\"weighted\"},\"assessments\":[{\"id\":\"a-1\",\"title\":\"Midterm\",\"weight\":0.4,\"status\":\"graded\",\"score\":{\"mode\":\"points\",\"earned\":32,\"possible\":40}},{\"id\":\"a-2\",\"title\":\"Final\",\"weight\":0.6,\"status\":\"ungraded\",\"score\":null}]}]}");}
  private void rejected(JSONObject invalid) throws Exception{
    String before=GradeBookStore.INSTANCE.read(context).toString();
    try{GradeBookStore.INSTANCE.save(context,invalid.toString());fail("Must reject invalid data");}catch(Exception expected){}
    assertEquals(before,GradeBookStore.INSTANCE.read(context).toString());
  }
  @Test public void saveReloadAndTimetableClearAreIndependent() throws Exception{
    assertNull(GradeBookStore.INSTANCE.read(context));GradeBookStore.INSTANCE.save(context,book().toString());
    assertEquals(book().toString(),GradeBookStore.INSTANCE.read(context).toString());
    CacheStore.INSTANCE.save(context,"{\"terms\":[]}");CacheStore.INSTANCE.clear(context);
    assertEquals(book().toString(),GradeBookStore.INSTANCE.read(context).toString());
  }
  @Test public void unknownVersionAndCredentialFieldsDoNotOverwriteGoodGrades() throws Exception{
    GradeBookStore.INSTANCE.save(context,book().toString());rejected(book().put("schemaVersion",2));rejected(book().put("access_token","synthetic-rejected"));
    JSONObject b=book();b.getJSONArray("courses").getJSONObject(0).put("outbox",new JSONArray());rejected(b);
  }
  @Test public void duplicateIdsAndInvalidScoreAreRejectedAtomically() throws Exception{
    GradeBookStore.INSTANCE.save(context,book().toString());JSONObject b=book();b.getJSONArray("courses").put(b.getJSONArray("courses").getJSONObject(0));rejected(b);
    b=book();b.getJSONArray("courses").getJSONObject(0).getJSONArray("assessments").getJSONObject(0).getJSONObject("score").put("earned",41);rejected(b);
    b=book();b.getJSONArray("courses").getJSONObject(0).getJSONArray("assessments").getJSONObject(1).put("score",new JSONObject().put("mode","ratio").put("value",.5));rejected(b);
  }
  @Test public void oversizedPayloadDoesNotOverwriteGoodGrades() throws Exception{
    GradeBookStore.INSTANCE.save(context,book().toString());String before=GradeBookStore.INSTANCE.read(context).toString();
    try{GradeBookStore.INSTANCE.save(context," ".repeat(CacheStore.MAX_BYTES+1));fail("Oversized data");}catch(Exception expected){}
    assertEquals(before,GradeBookStore.INSTANCE.read(context).toString());
  }
  @Test public void atomicBackupIsRecoveredAfterInterruptedReplacement() throws Exception{
    GradeBookStore.INSTANCE.save(context,book().toString());File base=new File(context.getFilesDir(),"grades-v1.json");
    assertTrue(base.renameTo(new File(context.getFilesDir(),"grades-v1.json.bak")));
    assertEquals(book().toString(),GradeBookStore.INSTANCE.read(context).toString());
  }
}
