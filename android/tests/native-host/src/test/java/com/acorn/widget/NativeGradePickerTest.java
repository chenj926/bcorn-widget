package com.acorn.widget;

import static org.junit.Assert.*;
import android.app.Activity;
import android.os.Bundle;
import com.acorn.widget.gradesync.*;
import com.google.android.gms.auth.api.identity.*;
import com.google.android.gms.tasks.Tasks;
import java.util.*;
import javax.crypto.spec.SecretKeySpec;
import kotlin.Unit;
import kotlin.jvm.functions.Function0;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** Synthetic Picker, sheet grid and mapped writes only; no account, grant or live sheet is accessed. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class NativeGradePickerTest {
  Activity activity; NativeGradeSyncTest.MemoryStorage storage; NativeGradeSyncTest.FakeAuthorization auth;
  GridTransport transport; NativeGradeSyncGateway gateway;
  @Before public void setup(){activity=Robolectric.buildActivity(Activity.class).setup().get();storage=new NativeGradeSyncTest.MemoryStorage();auth=new NativeGradeSyncTest.FakeAuthorization();transport=new GridTransport();gateway=new NativeGradeSyncGateway(activity,true,auth,storage,transport,Runnable::run,Runnable::run);gateway.onResume();}
  JSONObject call(String method,JSONObject args){final Object[] out={null};gateway.call(method,args,value->{out[0]=value;return Unit.INSTANCE;});return (JSONObject)out[0];}
  String error(JSONObject value)throws Exception{return value.getJSONObject("error").getString("code");}
  JSONObject pick(){return call("pickGradeSheet",new JSONObject());}
  JSONObject preview(JSONObject picked)throws Exception{return call("previewGradeSheet",new JSONObject().put("selectionId",picked.getString("selectionId")).put("sheetId",0));}
  JSONObject mapping()throws Exception{return new JSONObject("{\"schemaVersion\":1,\"confirmed\":true,\"sheetId\":0,\"tab\":\"Grades\",\"courses\":[{\"id\":\"synthetic-course\",\"title\":\"Synthetic course\",\"termId\":\"synthetic-term\",\"rules\":{\"kind\":\"weighted\"},\"assessments\":[{\"id\":\"synthetic-test\",\"title\":\"Test\",\"gradeCell\":\"C2\",\"weightCell\":\"B2\",\"gradeMode\":\"ratio\",\"weightMode\":\"ratio\",\"anchor\":{\"cell\":\"A2\",\"text\":\"Test\"}}]}]}");}
  JSONObject confirm(JSONObject picked)throws Exception{return call("confirmGradeSheetMapping",new JSONObject().put("selectionId",picked.getString("selectionId")).put("mapping",mapping()));}
  JSONObject read(String id)throws Exception{return call("readMappedGradeSnapshot",new JSONObject().put("connectionId",id));}
  JSONObject commit(String id,JSONObject expected,Object desired)throws Exception{return call("commitMappedGradeCells",new JSONObject().put("connectionId",id).put("expectedSnapshot",expected).put("writes",new JSONArray().put(new JSONObject().put("cell","C2").put("value",desired))));}

  @Test public void actualSdkPickerUsesOnlyDriveFileConsentAndSpreadsheetFilter()throws Exception{
    Bundle parameters=new Bundle();parameters.putString("picked_file_ids","synthetic-picked-file");final AuthorizationRequest[] captured={null};
    AuthorizationClient sdk=(AuthorizationClient)java.lang.reflect.Proxy.newProxyInstance(AuthorizationClient.class.getClassLoader(),new Class<?>[]{AuthorizationClient.class},(proxy,method,args)->{captured[0]=(AuthorizationRequest)args[0];return Tasks.forResult(new AuthorizationResult(null,"synthetic-token",null,Collections.singletonList(GoogleGradeAuthorization.DRIVE_FILE),null,null,parameters));});
    GoogleGradeAuthorization google=new GoogleGradeAuthorization(activity,()->sdk,()->true,intent->{fail("Synthetic SDK result needs no UI");return Unit.INSTANCE;});google.setForeground(true);final NativeAuthorizationResult[] out={null};google.pickSheet(value->{out[0]=value;return Unit.INSTANCE;});org.robolectric.shadows.ShadowLooper.idleMainLooper();
    assertEquals(1,captured[0].getRequestedScopes().size());assertEquals(GoogleGradeAuthorization.DRIVE_FILE,captured[0].getRequestedScopes().get(0).getScopeUri());assertTrue(captured[0].getOptOutIncludingGrantedScopes());assertFalse(captured[0].isOfflineAccessRequested());assertNull(captured[0].getServerClientId());assertEquals(AuthorizationRequest.Prompt.CONSENT|AuthorizationRequest.Prompt.SELECT_ACCOUNT,captured[0].getPrompt());
    assertEquals("true",captured[0].getResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_OAUTH_TRIGGER));assertEquals("false",captured[0].getResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_ALLOW_MULTIPLE));assertEquals("false",captured[0].getResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_ALLOW_FOLDER_SELECTION));assertEquals("application/vnd.google-apps.spreadsheet",captured[0].getResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_MIMETYPES));assertNull(captured[0].getResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_FILE_IDS));assertEquals("synthetic-picked-file",out[0].getPickedFileId());assertEquals("NativeAuthorizationResult(redacted)",out[0].toString());
  }
  @Test public void actualSdkRejectsMissingMultipleAndMalformedPickerIds()throws Exception{
    for(String id:new String[]{"","one,two","https://evil.example/file","../other"}){Bundle params=new Bundle();params.putString("picked_file_ids",id);AuthorizationClient sdk=(AuthorizationClient)java.lang.reflect.Proxy.newProxyInstance(AuthorizationClient.class.getClassLoader(),new Class<?>[]{AuthorizationClient.class},(proxy,method,args)->Tasks.forResult(new AuthorizationResult(null,"synthetic-token",null,Collections.singletonList(GoogleGradeAuthorization.DRIVE_FILE),null,null,params)));GoogleGradeAuthorization google=new GoogleGradeAuthorization(activity,()->sdk,()->true,intent->Unit.INSTANCE);google.setForeground(true);final NativeAuthorizationResult[] out={null};google.pickSheet(value->{out[0]=value;return Unit.INSTANCE;});org.robolectric.shadows.ShadowLooper.idleMainLooper();assertEquals("invalid-selection",out[0].getError());assertNull(out[0].getToken());}
  }
  @Test public void pickingBlocksOldConnectionAndOnlyReadsSelectedMetadata()throws Exception{
    GradeSheetBinding old=new GradeSheetBinding("synthetic-old","Old","11111111-1111-4111-8111-111111111111");storage.bind(old);JSONObject picked=pick();assertTrue(picked.getBoolean("readOnly"));assertEquals(0,picked.getJSONArray("tabs").getJSONObject(0).getInt("sheetId"));assertTrue(storage.authorizationBlocked());assertEquals(old.getConnectionId(),storage.binding().getConnectionId());assertEquals(1,transport.requests.size());assertEquals("GET",transport.requests.get(0).getMethod());assertTrue(transport.requests.get(0).getPath().startsWith("/v4/spreadsheets/picked-sheet?fields="));assertFalse(picked.toString().contains("picked-sheet"));assertFalse(picked.toString().contains("synthetic-native-token"));assertEquals(0,transport.posts);
  }
  @Test public void callerCannotChooseFileOrPreviewUnknownSelectionOrTab()throws Exception{
    assertEquals("invalid-request",error(call("pickGradeSheet",new JSONObject().put("spreadsheetId","other"))));assertEquals(0,auth.calls);JSONObject picked=pick();int count=transport.requests.size();assertEquals("invalid-selection",error(call("previewGradeSheet",new JSONObject().put("selectionId","unknown").put("sheetId",0))));assertEquals("invalid-selection",error(call("previewGradeSheet",new JSONObject().put("selectionId",picked.getString("selectionId")).put("sheetId",7))));assertEquals(count,transport.requests.size());
  }
  @Test public void previewIsFixedCompleteWindowAndDoesNotBindOrWrite()throws Exception{
    JSONObject picked=pick(),snapshot=preview(picked);assertTrue(snapshot.getBoolean("complete"));assertEquals(5200,snapshot.getJSONObject("cells").length());assertEquals("",snapshot.getJSONObject("cells").getJSONObject("Z200").getString("value"));assertEquals(0.8,snapshot.getJSONObject("cells").getJSONObject("C2").getDouble("value"),0);assertNull(storage.binding());assertEquals(0,transport.posts);String path=transport.requests.get(1).getPath();assertTrue(path.contains("A1%3AZ200"));assertTrue(path.contains("includeGridData=true"));assertFalse(snapshot.toString().contains("spreadsheetId"));
  }
  @Test public void snapshotReturnsFormulaFlagWithoutFormulaTextAndMarksUnsafeCells()throws Exception{
    JSONObject body=transport.grid();JSONObject sheet=body.getJSONArray("sheets").getJSONObject(0);sheet.getJSONArray("data").getJSONObject(0).getJSONArray("rowData").getJSONObject(1).getJSONArray("values").getJSONObject(2).put("userEnteredValue",new JSONObject().put("formulaValue","=PRIVATE_SYNTHETIC()"));sheet.put("merges",new JSONArray().put(new JSONObject().put("sheetId",0).put("startRowIndex",1).put("endRowIndex",2).put("startColumnIndex",2).put("endColumnIndex",3)));sheet.put("protectedRanges",new JSONArray().put(new JSONObject()));JSONObject snapshot=GradeSheetSelection.Companion.snapshot(body,0,"Grades"),cell=snapshot.getJSONObject("cells").getJSONObject("C2");assertTrue(cell.getBoolean("formula"));assertTrue(cell.getBoolean("merged"));assertTrue(cell.getBoolean("protected"));assertFalse(snapshot.toString().contains("PRIVATE_SYNTHETIC"));
  }
  @Test public void confirmationRereadsBeforeNewConnectionAndKeepsFileIdPrivate()throws Exception{
    JSONObject picked=pick();preview(picked);int before=transport.requests.size();JSONObject connected=confirm(picked);assertTrue(connected.getBoolean("ok"));assertEquals(before+1,transport.requests.size());assertEquals(0,transport.posts);assertFalse(storage.authorizationBlocked());assertEquals("mapped",connected.getJSONObject("binding").getString("kind"));assertFalse(connected.toString().contains("picked-sheet"));assertNotNull(storage.binding().getMapping());assertEquals("picked-sheet",storage.binding().getSpreadsheetId());assertNotNull(read(connected.getString("connectionId")).getJSONObject("cells"));assertEquals("invalid-selection",error(preview(picked)));
  }
  @Test public void confirmationRejectsFormulaOrChangedAnchorWithoutBinding()throws Exception{
    JSONObject picked=pick();transport.formula=true;assertEquals("mapping-changed",error(confirm(picked)));assertNull(storage.binding());assertEquals(0,transport.posts);transport.formula=false;transport.label="Renamed";assertEquals("mapping-changed",error(confirm(picked)));assertNull(storage.binding());
  }
  @Test public void mappedWriteRequiresFreshSnapshotUsesRawExactCellAndVerifiesReadback()throws Exception{
    String id=confirm(pick()).getString("connectionId");JSONObject before=read(id);JSONObject result=commit(id,before,"4/5");assertTrue(result.getBoolean("ok"));assertEquals("4/5",result.getJSONObject("snapshot").getJSONObject("cells").getJSONObject("C2").getString("value"));assertEquals(1,transport.posts);SheetRequest sent=transport.requests.stream().filter(r->r.getMethod().equals("POST")).findFirst().get();assertEquals("/v4/spreadsheets/picked-sheet/values:batchUpdate",sent.getPath());assertEquals("RAW",sent.getBody().getString("valueInputOption"));assertEquals("'Grades'!C2",sent.getBody().getJSONArray("data").getJSONObject(0).getString("range"));assertEquals(1,sent.getBody().getJSONArray("data").length());
  }
  @Test public void staleSnapshotAndFormulaAddedBeforeWriteNeverPost()throws Exception{
    String id=confirm(pick()).getString("connectionId");JSONObject before=read(id);transport.score=0.7;assertEquals("conflict",error(commit(id,before,0.6)));assertEquals(0,transport.posts);transport.score=0.8;transport.formula=true;assertEquals("mapping-changed",error(commit(id,before,0.6)));assertEquals(0,transport.posts);
  }
  @Test public void postWriteReadbackMismatchIsNotReportedAsSuccess()throws Exception{
    String id=confirm(pick()).getString("connectionId");JSONObject before=read(id);transport.ignoreWrite=true;assertEquals("conflict",error(commit(id,before,0.6)));assertEquals(1,transport.posts);
  }
  @Test public void pausedMappedCommitAndWrongConnectionCannotSend()throws Exception{
    String id=confirm(pick()).getString("connectionId");JSONObject before=read(id);int count=transport.requests.size();assertEquals("connection-changed",error(commit("wrong",before,0.6)));gateway.onPause();assertEquals("offline",error(commit(id,before,0.6)));assertEquals(count,transport.requests.size());
  }
  @Test public void mappedBindingCannotUseFourteenColumnProxy()throws Exception{
    confirm(pick());int count=transport.requests.size();assertEquals("invalid-request",error(call("gradeSheetsRequest",new JSONObject().put("method","GET").put("path","/v4/spreadsheets/picked-sheet/values/'Grades'!A1:N1002?valueRenderOption=UNFORMATTED_VALUE"))));assertEquals(count,transport.requests.size());
  }
  @Test public void mappedBindingAndJournalSurviveEncryptedStorageReload()throws Exception{
    confirm(pick());AndroidGradeStateCipher cipher=new AndroidGradeStateCipher(()->new SecretKeySpec(new byte[32],"AES"));EncryptedGradeSyncStorage disk=new EncryptedGradeSyncStorage(activity,cipher);disk.bind(storage.binding());EncryptedGradeSyncStorage reloaded=new EncryptedGradeSyncStorage(activity,cipher);assertEquals(storage.binding().getConnectionId(),reloaded.binding().getConnectionId());assertEquals(mapping().toString(),reloaded.binding().getMapping().toString());assertFalse(reloaded.binding().publicJson().toString().contains("picked-sheet"));
  }
  @Test public void cancelledPickerRetainsBlockedOldBindingAndNeverReadsOrWrites()throws Exception{
    storage.bind(new GradeSheetBinding("synthetic-old","Old","11111111-1111-4111-8111-111111111111"));auth.error="cancelled";assertEquals("cancelled",error(pick()));assertTrue(storage.authorizationBlocked());assertEquals("synthetic-old",storage.binding().getSpreadsheetId());assertTrue(transport.requests.isEmpty());
  }
  JSONObject course()throws Exception{return new JSONObject("{\"id\":\"synthetic-course\",\"title\":\"Synthetic course\",\"termId\":\"synthetic-term\",\"rules\":{\"kind\":\"weighted\"},\"assessments\":[{\"id\":\"synthetic-test\",\"title\":\"Test\",\"weight\":0.2,\"status\":\"graded\",\"score\":{\"mode\":\"ratio\",\"value\":0}}]}");}
  @Test public void newMappedTemplateIsNativeDerivedAndReadBackBeforeBinding()throws Exception{
    JSONObject result=call("createMappedGradeSheet",new JSONObject().put("course",course()));assertTrue(result.getBoolean("ok"));assertTrue(auth.interactive);assertEquals("synthetic-created-mapped",storage.binding().getSpreadsheetId());assertEquals("mapped",result.getJSONObject("binding").getString("kind"));assertFalse(result.toString().contains("synthetic-created-mapped"));assertEquals(2,transport.requests.size());SheetRequest create=transport.requests.get(0);assertEquals("/v4/spreadsheets",create.getPath());assertEquals("POST",create.getMethod());JSONArray row=create.getBody().getJSONArray("sheets").getJSONObject(0).getJSONArray("data").getJSONObject(0).getJSONArray("rowData").getJSONObject(1).getJSONArray("values");assertEquals(0,row.getJSONObject(2).getJSONObject("userEnteredValue").getDouble("numberValue"),0);assertTrue(row.getJSONObject(3).getJSONObject("userEnteredValue").getString("formulaValue").startsWith("=IF(C2=\"\""));assertEquals("GET",transport.requests.get(1).getMethod());
  }
  @Test public void malformedOrExemptTemplateNeverAuthorizesOrCreates()throws Exception{
    JSONObject invalid=course().put("formula","=1");assertEquals("invalid-request",error(call("createMappedGradeSheet",new JSONObject().put("course",invalid))));invalid=course();invalid.getJSONArray("assessments").getJSONObject(0).put("status","exempt");assertEquals("invalid-request",error(call("createMappedGradeSheet",new JSONObject().put("course",invalid))));assertEquals(0,auth.calls);assertTrue(transport.requests.isEmpty());
  }
  @Test public void previewParsingAndPolicyRunOnStateExecutor()throws Exception{
    List<Runnable> queued=new ArrayList<>();gateway=new NativeGradeSyncGateway(activity,true,auth,storage,transport,Runnable::run,queued::add);gateway.onResume();final Object[] result={null};gateway.call("pickGradeSheet",new JSONObject(),value->{result[0]=value;return Unit.INSTANCE;});assertEquals(1,queued.size());assertTrue(transport.requests.isEmpty());queued.remove(0).run();assertEquals(1,queued.size());queued.remove(0).run();assertEquals(1,transport.requests.size());assertNull(result[0]);assertEquals(1,queued.size());queued.remove(0).run();assertNotNull(result[0]);
  }
  @Test public void nativeAccountFingerprintIsCachedPerTokenAndNeverPublic()throws Exception{
    JSONObject connected=confirm(pick());String id=connected.getString("connectionId");assertEquals(1,transport.identityCalls);read(id);read(id);assertEquals(1,transport.identityCalls);assertNotNull(storage.binding().getAccountKey());assertFalse(connected.toString().contains("accountKey"));assertFalse(connected.toString().contains("synthetic-account"));assertFalse(connected.toString().contains(storage.binding().getAccountKey()));auth.token="synthetic-renewed-token";read(id);assertEquals(2,transport.identityCalls);
  }
  @Test public void differentAccountCannotUseOldMappedConnectionEvenForSharedFile()throws Exception{
    String id=confirm(pick()).getString("connectionId");JSONObject before=read(id);int count=transport.requests.size();gateway.onPause();gateway.onResume();transport.identity="another-synthetic-account";assertEquals("authorization-required",error(commit(id,before,0.5)));assertEquals(count,transport.requests.size());assertEquals(0,transport.posts);assertTrue(storage.authorizationBlocked());assertEquals(id,storage.binding().getConnectionId());
  }
  @Test public void differentAccountCannotConfirmOldPickerSelection()throws Exception{
    JSONObject picked=pick();gateway.onPause();gateway.onResume();transport.identity="another-synthetic-account";int count=transport.requests.size();assertEquals("authorization-required",error(confirm(picked)));assertEquals(count,transport.requests.size());assertNull(storage.binding());
  }
  @Test public void queuedBootstrapAndQueuedConsentTransitionCannotCrossPauseResume()throws Exception{
    for(int stage=0;stage<2;stage++){setup();List<Runnable> queued=new ArrayList<>();gateway=new NativeGradeSyncGateway(activity,true,auth,storage,transport,Runnable::run,queued::add);gateway.onResume();final JSONObject[] out={null};gateway.call("pickGradeSheet",new JSONObject(),value->{out[0]=(JSONObject)value;return Unit.INSTANCE;});if(stage==1)queued.remove(0).run();gateway.onPause();gateway.onResume();while(!queued.isEmpty())queued.remove(0).run();assertEquals("offline",error(out[0]));assertEquals(0,auth.calls);assertTrue(transport.requests.isEmpty());assertEquals(0,transport.identityCalls);}
  }
  @Test public void newTemplateMismatchedInitialReadbackNeverReplacesOldBinding()throws Exception{
    GradeSheetBinding old=new GradeSheetBinding("synthetic-old","Old","11111111-1111-4111-8111-111111111111",null,NativeGradeSyncTest.accountKey());storage.bind(old);transport.corruptCreatedReadback=true;JSONObject requested=course();requested.getJSONArray("assessments").getJSONObject(0).getJSONObject("score").put("value",0.8);assertEquals("conflict",error(call("createMappedGradeSheet",new JSONObject().put("course",requested))));assertEquals(old.getConnectionId(),storage.binding().getConnectionId());assertTrue(storage.authorizationBlocked());assertEquals(1,transport.posts);
  }
  @Test public void legacyUnpinnedBindingRequiresExplicitReconnect()throws Exception{
    storage.bind(new GradeSheetBinding("synthetic-old","Old","11111111-1111-4111-8111-111111111111"));JSONObject status=call("getGradeSyncStatus",new JSONObject());assertEquals("authorization-required",status.getString("state"));assertTrue(transport.requests.isEmpty());assertEquals(0,transport.identityCalls);
  }
  static class GridTransport implements GradeSheetsTransport {
    List<SheetRequest> requests=new ArrayList<>();int identityCalls;String identity="synthetic-account";Object score=0.8;double weight=0.2;String label="Test";boolean formula,ignoreWrite,corruptCreatedReadback;int posts;
    JSONObject cell(Object value)throws Exception{return new JSONObject().put("userEnteredValue",new JSONObject().put(value instanceof Number?"numberValue":"stringValue",value)).put("effectiveValue",new JSONObject().put(value instanceof Number?"numberValue":"stringValue",value));}
    JSONObject grid()throws Exception{JSONArray values=new JSONArray().put(cell(label)).put(cell(weight)).put(cell(score));if(formula)values.getJSONObject(2).put("userEnteredValue",new JSONObject().put("formulaValue","=1/2"));return new JSONObject().put("sheets",new JSONArray().put(new JSONObject().put("properties",new JSONObject().put("sheetId",0).put("title","Grades")).put("data",new JSONArray().put(new JSONObject().put("rowData",new JSONArray().put(new JSONObject()).put(new JSONObject().put("values",values)))))));}
    public SheetResponse execute(SheetRequest request,String token,Function0<Boolean> active){if(!active.invoke())throw new IllegalStateException("offline");try{if(request.getPath().equals(GradeAccountIdentity.PATH)){identityCalls++;return new SheetResponse(200,new JSONObject().put("user",new JSONObject().put("permissionId",identity)),0);}requests.add(request);if(request.getMethod().equals("POST")){posts++;if(request.getPath().equals("/v4/spreadsheets")){JSONArray created=request.getBody().getJSONArray("sheets").getJSONObject(0).getJSONArray("data").getJSONObject(0).getJSONArray("rowData").getJSONObject(1).getJSONArray("values");label=created.getJSONObject(0).getJSONObject("userEnteredValue").getString("stringValue");weight=created.getJSONObject(1).getJSONObject("userEnteredValue").getDouble("numberValue");JSONObject entered=created.getJSONObject(2).getJSONObject("userEnteredValue");score=entered.has("numberValue")?entered.getDouble("numberValue"):entered.getString("stringValue");if(corruptCreatedReadback)score=0.2;return new SheetResponse(200,new JSONObject().put("spreadsheetId","synthetic-created-mapped").put("sheets",new JSONArray().put(new JSONObject().put("properties",new JSONObject().put("sheetId",0).put("title","Grades")))),0);}if(!ignoreWrite){JSONArray rows=request.getBody().getJSONArray("data");for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);Object value=row.getJSONArray("values").getJSONArray(0).get(0);if(row.getString("range").endsWith("!C2"))score=value;else if(row.getString("range").endsWith("!B2"))weight=((Number)value).doubleValue();else throw new AssertionError("Unexpected target");}}return new SheetResponse(200,new JSONObject(),0);}if(request.getPath().contains("includeGridData=true"))return new SheetResponse(200,grid(),0);return new SheetResponse(200,new JSONObject().put("properties",new JSONObject().put("title","Synthetic personal template")).put("sheets",new JSONArray().put(new JSONObject().put("properties",new JSONObject().put("sheetId",0).put("title","Grades").put("sheetType","GRID")))),0);}catch(Exception error){throw new RuntimeException(error);}}
    public void cancel(){}
  }
}
