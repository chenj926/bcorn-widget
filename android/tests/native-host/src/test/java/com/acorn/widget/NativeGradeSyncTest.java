package com.acorn.widget;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.PendingIntent;
import com.google.android.gms.auth.api.identity.*;
import com.google.android.gms.tasks.*;
import android.content.Context;
import android.content.Intent;
import com.acorn.widget.gradesync.*;
import java.io.*;
import java.net.URL;
import java.security.Principal;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.Executor;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.*;
import okio.*;
import kotlin.Unit;
import kotlin.jvm.functions.Function0;
import kotlin.jvm.functions.Function1;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

/** All accounts, tokens, HTTP responses and keys are synthetic. No Google authorization is invoked. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class NativeGradeSyncTest {
  private Activity activity;
  private MemoryStorage store;
  private FakeAuthorization auth;
  private FakeTransport transport;
  private NativeGradeSyncGateway gateway;
  private static final String CONNECTION="11111111-1111-4111-8111-111111111111";
  private static final String OTHER="22222222-2222-4222-8222-222222222222";
  private GradeSheetBinding binding(){return new GradeSheetBinding("synthetic_sheet", "Assessments", CONNECTION,null,accountKey());}
  static String accountKey(){try{return GradeAccountIdentity.INSTANCE.fingerprint("synthetic-device",new JSONObject().put("user",new JSONObject().put("permissionId","synthetic-account")));}catch(Exception e){throw new RuntimeException(e);}}
  @Before public void setup(){
    activity=Robolectric.buildActivity(Activity.class).setup().get();store=new MemoryStorage();auth=new FakeAuthorization();transport=new FakeTransport();
    gateway=new NativeGradeSyncGateway(activity,true,auth,store,transport,Runnable::run,Runnable::run);gateway.onResume();
  }
  private Object call(String method,JSONObject arguments){final Object[] output={null};gateway.call(method,arguments,value->{output[0]=value;return Unit.INSTANCE;});return output[0];}
  private JSONObject status(){return (JSONObject)call("getGradeSyncStatus",new JSONObject());}
  private JSONObject connect()throws Exception{return (JSONObject)call("connectGradeSheet",new JSONObject().put("title","Synthetic grade table").put("tab","Assessments"));}
  private JSONObject read()throws Exception{return new JSONObject().put("method","GET").put("path","/v4/spreadsheets/synthetic_sheet/values/"+GradeSheetsPolicy.INSTANCE.encode("'Assessments'!A1:N1002")+"?valueRenderOption=UNFORMATTED_VALUE");}
  private JSONObject write(int row,JSONArray values)throws Exception{String range="'Assessments'!A"+row+":N"+row;return new JSONObject().put("method","PUT").put("path","/v4/spreadsheets/synthetic_sheet/values/"+GradeSheetsPolicy.INSTANCE.encode(range)+"?valueInputOption=RAW").put("body",new JSONObject().put("range",range).put("majorDimension","ROWS").put("values",new JSONArray().put(values)));}
  private JSONArray course()throws Exception{return new JSONArray("[\"c:one\",\"course\",\"one\",\"Synthetic\",\"fall\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"weighted\"]");}
  private JSONObject envelope()throws Exception{return new JSONObject("{\"schemaVersion\":1,\"coordinator\":{\"schemaVersion\":1,\"records\":{},\"base\":{},\"outbox\":{},\"conflicts\":{},\"sequence\":0,\"status\":\"pending\",\"authorizationBlocked\":false},\"publishedBook\":{\"schemaVersion\":1,\"courses\":[]}}");}
  private void rejects(JSONObject request){try{GradeSheetsPolicy.INSTANCE.validate(binding(),request);fail("Expected fail-closed request policy");}catch(Exception expected){}}
  private String code(Object result)throws Exception{return ((JSONObject)result).getJSONObject("error").getString("code");}
  @Test public void onlyDriveFileAndNoSecretJsonShape()throws Exception{
    assertEquals("https://www.googleapis.com/auth/drive.file",GoogleGradeAuthorization.DRIVE_FILE);
    assertEquals("NativeAuthorizationResult(redacted)",new NativeAuthorizationResult("synthetic-native-token",null).toString());
    store.binding=binding();assertEquals("ready",status().getString("state"));
    String json=status().toString();assertFalse(json.contains("synthetic-native-token"));assertFalse(json.contains("accessToken"));assertFalse(status().getBoolean("automaticInbound"));
  }
  @Test public void missingConfigurationAndGmsNeverAuthorizeOrCreate()throws Exception{
    gateway=new NativeGradeSyncGateway(activity,false,auth,store,transport,Runnable::run,Runnable::run);gateway.onResume();assertEquals("not-configured",status().getString("state"));assertEquals("not-configured",code(connect()));assertEquals(0,auth.calls);assertEquals(0,transport.calls);
    gateway=new NativeGradeSyncGateway(activity,true,auth,store,transport,Runnable::run,Runnable::run);gateway.onResume();auth.available=false;assertEquals("not-configured",status().getString("state"));assertEquals("not-configured",code(connect()));assertEquals(0,auth.calls);
  }
  @Test public void blankInstallNeedsExplicitConnect()throws Exception{assertEquals("authorization-required",status().getString("state"));assertEquals(0,auth.calls);assertTrue(status().isNull("binding"));}
  @Test public void templateExactlyMatchesSharedFourteenColumnFormat()throws Exception{
    JSONObject template=GradeSheetsPolicy.INSTANCE.template("Synthetic","Assessments");JSONObject sheet=template.getJSONArray("sheets").getJSONObject(0);
    JSONObject grid=sheet.getJSONObject("properties").getJSONObject("gridProperties");assertEquals(1002,grid.getInt("rowCount"));assertEquals(14,grid.getInt("columnCount"));assertEquals(1,grid.getInt("frozenRowCount"));
    JSONArray headers=sheet.getJSONArray("data").getJSONObject(0).getJSONArray("rowData").getJSONObject(0).getJSONArray("values");assertEquals(14,headers.length());
    for(int i=0;i<14;i++)assertEquals(GradeSheetsPolicy.INSTANCE.getHEADERS().get(i),headers.getJSONObject(i).getJSONObject("userEnteredValue").getString("stringValue"));
  }
  @Test public void cancelledConsentPreservesOldConnectionAndDoesNotCreate()throws Exception{
    store.binding=binding();auth.error="cancelled";assertEquals("cancelled",code(connect()));assertEquals(CONNECTION,store.binding.getConnectionId());assertEquals(0,transport.calls);assertTrue(auth.interactive);
  }
  @Test public void reconnectCreatesNewFileAndOpaqueConnection()throws Exception{
    store.binding=binding();String old=store.binding.getConnectionId();JSONObject result=connect();assertTrue(result.getBoolean("ok"));assertEquals("POST",transport.last.getMethod());assertEquals("/v4/spreadsheets",transport.last.getPath());assertNotEquals(old,store.binding.getConnectionId());assertTrue(result.getJSONObject("binding").getBoolean("confirmed"));assertFalse(result.toString().contains("synthetic-native-token"));
  }
  @Test public void invalidCreateResponseCannotReplaceBinding()throws Exception{
    store.binding=binding();transport.response=new SheetResponse(200,new JSONObject().put("spreadsheetId","bad/id").put("sheets",new JSONArray()),0);assertEquals("invalid-response",code(connect()));assertEquals(CONNECTION,store.binding.getConnectionId());
  }
  @Test public void consentWaitsForResumeBeforeNetwork()throws Exception{
    auth.defer=true;final Object[] output={null};gateway.call("connectGradeSheet",new JSONObject().put("title","Synthetic").put("tab","Assessments"),value->{output[0]=value;return Unit.INSTANCE;});
    gateway.onPause();auth.finish();assertEquals(0,transport.calls);assertNull(output[0]);gateway.onResume();assertEquals(1,transport.calls);assertTrue(((JSONObject)output[0]).getBoolean("ok"));
  }
  @Test public void destroyedConsentCannotCreateLater()throws Exception{
    auth.defer=true;call("connectGradeSheet",new JSONObject().put("title","Synthetic").put("tab","Assessments"));gateway.onDestroy();auth.finish();assertEquals(0,transport.calls);assertNull(store.binding);assertTrue(auth.closed);
  }
  @Test public void silentAuthorizationNeverBecomesInteractive()throws Exception{
    store.binding=binding();auth.error="authorization-required";assertEquals("authorization-required",status().getString("state"));assertFalse(auth.interactive);assertEquals(0,transport.calls);
  }
  @Test public void noHttpOrAuthorizationWhilePaused()throws Exception{
    store.binding=binding();gateway.onPause();assertEquals("offline",code(call("gradeSheetsRequest",read())));assertEquals(0,auth.calls);assertEquals(0,transport.calls);assertFalse(status().getBoolean("foregroundSyncAvailable"));
  }
  @Test public void pauseInvalidatesQueuedHttpAndPreservesJournal()throws Exception{
    List<Runnable> queue=new ArrayList<>();gateway=new NativeGradeSyncGateway(activity,true,auth,store,transport,queue::add,Runnable::run);gateway.onResume();store.binding=binding();status();queue.remove(0).run();final Object[] result={null};gateway.call("gradeSheetsRequest",read(),value->{result[0]=value;return Unit.INSTANCE;});gateway.onPause();queue.get(0).run();assertEquals("offline",code(result[0]));assertTrue(transport.cancelled);assertEquals(0,transport.sideEffects);
  }
  @Test public void unauthorizedClearsSdkTokenAndBlocksSuccess()throws Exception{
    store.binding=binding();status();transport.response=new SheetResponse(401,new JSONObject().put("access_token","must-not-escape"),0);JSONObject response=(JSONObject)call("gradeSheetsRequest",read());assertEquals(401,response.getInt("status"));assertEquals(1,auth.clears);assertEquals("{}",response.getJSONObject("body").toString());
  }
  @Test public void filePermissionFailureRequiresRelinkWithoutRevokingSdkGrant()throws Exception{
    store.binding=binding();status();transport.response=new SheetResponse(403,new JSONObject().put("error",new JSONObject().put("errors",new JSONArray().put(new JSONObject().put("reason","insufficientFilePermissions")))),0);
    JSONObject result=(JSONObject)call("gradeSheetsRequest",read());assertEquals(404,result.getInt("status"));assertEquals("ready",status().getString("state"));assertEquals(0,auth.clears);assertEquals(CONNECTION,store.binding.getConnectionId());assertFalse(store.authorizationBlocked());
  }
  @Test public void sheetsAndDriveQuota403KeepBindingAndUseBackoff()throws Exception{
    store.binding=binding();status();transport.response=new SheetResponse(403,new JSONObject().put("error",new JSONObject().put("errors",new JSONArray().put(new JSONObject().put("reason","userRateLimitExceeded")))),120000);
    JSONObject sheets=(JSONObject)call("gradeSheetsRequest",read());assertEquals(429,sheets.getInt("status"));assertEquals(120000,sheets.getLong("retryAfterMs"));
    JSONObject drive=(JSONObject)call("gradeSheetVersion",new JSONObject());assertEquals("rate-limited",code(drive));assertEquals(120000,drive.getJSONObject("error").getLong("retryAfterMs"));assertEquals(0,auth.clears);assertEquals("ready",status().getString("state"));assertFalse(store.authorizationBlocked());
  }
  @Test public void readsExposeOnlyValuesAndNoApiMetadata()throws Exception{
    store.binding=binding();status();transport.response=new SheetResponse(200,new JSONObject().put("values",new JSONArray().put(new JSONArray(GradeSheetsPolicy.INSTANCE.getHEADERS()))).put("syntheticAccount","must-not-escape"),0);JSONObject response=(JSONObject)call("gradeSheetsRequest",read());assertTrue(response.getJSONObject("body").has("values"));assertFalse(response.toString().contains("must-not-escape"));
  }
  @Test public void exactBoundReadAndRawSingleRowWriteAreAllowed()throws Exception{assertEquals("GET",GradeSheetsPolicy.INSTANCE.validate(binding(),read()).getMethod());assertEquals("PUT",GradeSheetsPolicy.INSTANCE.validate(binding(),write(2,course())).getMethod());}
  @Test public void rejectsOtherFilesTabsHeaderRowsAndNonRawOptions()throws Exception{
    JSONObject r=read();r.put("path",r.getString("path").replace("synthetic_sheet","other_sheet"));rejects(r);
    r=read();r.put("path",r.getString("path").replace("Assessments","Other"));rejects(r);rejects(write(1,course()));rejects(write(1002,course()));
    r=write(2,course());r.put("path",r.getString("path").replace("RAW","USER_ENTERED"));rejects(r);
  }
  @Test public void rejectsAbsoluteDoubleEncodedTraversalAndArbitraryBodies()throws Exception{
    for(String p:new String[]{"https://evil.example/v4/spreadsheets","//evil.example/path","/v4/spreadsheets/synthetic_sheet/../other","/v4/spreadsheets/synthetic_sheet/values/%2527Assessments%2527%21A1%3AN1002?valueRenderOption=UNFORMATTED_VALUE"})rejects(new JSONObject().put("method","GET").put("path",p));
    JSONObject r=read();r.put("headers",new JSONObject());rejects(r);r=write(2,course());r.getJSONObject("body").put("includeValuesInResponse",true);rejects(r);r=write(2,course());r.getJSONObject("body").getJSONArray("values").put(course());rejects(r);
  }
  @Test public void invalidTransportRequestsNeverAskGoogle()throws Exception{store.binding=binding();JSONObject bad=read().put("method","DELETE");assertEquals("invalid-request",code(call("gradeSheetsRequest",bad)));assertEquals(0,auth.calls);assertEquals(0,transport.calls);}
  @Test public void rowBoundaryRejectsWrongTypesAndPermitsLiteralFormulaAsRawText()throws Exception{
    JSONArray row=course();row.put(3,"=HYPERLINK(\"synthetic\")");GradeSheetsPolicy.INSTANCE.validate(binding(),write(2,row));row=course();row.put(13,"any-rule");rejects(write(2,row));row=course();row.put(3,new JSONObject().put("arbitrary",true));rejects(write(2,row));
  }
  private AndroidGradeStateCipher cipher(){return new AndroidGradeStateCipher(()->new SecretKeySpec(new byte[32],"AES"));}
  private EncryptedGradeSyncStorage encrypted()throws Exception{return new EncryptedGradeSyncStorage(activity,cipher());}
  @Test public void realAesGcmAuthenticatesPurposeAndRejectsTampering()throws Exception{
    AndroidGradeStateCipher cipher=cipher();byte[] clear="synthetic private grades".getBytes("UTF-8"),data=cipher.encrypt("journal-A",clear);assertFalse(Arrays.equals(clear,data));assertArrayEquals(clear,cipher.decrypt("journal-A",data));
    try{cipher.decrypt("journal-B",data);fail("AAD isolation");}catch(Exception expected){}data[data.length-1]^=1;try{cipher.decrypt("journal-A",data);fail("GCM tamper rejection");}catch(Exception expected){}
  }
  @Test public void encryptedDiskIsPrivateAndConnectionIsolated()throws Exception{
    EncryptedGradeSyncStorage storage=encrypted();storage.bind(binding());storage.save(CONNECTION,envelope());String device=storage.deviceId();assertEquals(device,encrypted().deviceId());assertEquals(envelope().toString(),encrypted().load(CONNECTION).toString());
    File dir=new File(activity.getNoBackupFilesDir(),"grade-sync-v1");assertTrue(dir.isDirectory());for(File f:dir.listFiles()){String bytes=new String(java.nio.file.Files.readAllBytes(f.toPath()),"ISO-8859-1");assertFalse(bytes.contains("publishedBook"));assertFalse(bytes.contains("synthetic_sheet"));}
    storage.bind(new GradeSheetBinding("another_sheet","Assessments",OTHER));assertNull(storage.load(OTHER));try{storage.load(CONNECTION);fail("Old journal must not load for new connection");}catch(Exception expected){}
    try{storage.save(CONNECTION,envelope());fail("Old journal must not write for new connection");}catch(Exception expected){}
  }
  @Test public void oversizedUnknownAndCredentialEnvelopesPreserveDisk()throws Exception{
    EncryptedGradeSyncStorage storage=encrypted();storage.bind(binding());storage.save(CONNECTION,envelope());
    for(JSONObject invalid:new JSONObject[]{envelope().put("schemaVersion",2),envelope().put("access_token","synthetic-rejected"),envelope().put("extra","x".repeat(GradeSheetsPolicy.MAX_BYTES+1))}){try{storage.save(CONNECTION,invalid);fail("Invalid envelope");}catch(Exception expected){}assertEquals(envelope().toString(),storage.load(CONNECTION).toString());}
  }
  @Test public void httpBoundaryPinsHostDisablesRedirectsAndRedactsErrors()throws Exception{
    FakeCall connection=new FakeCall();connection.code=302;connection.input="{\"access_token\":\"synthetic\"}";
    HttpsGradeSheetsTransport http=new HttpsGradeSheetsTransport(request->{assertEquals("sheets.googleapis.com",request.url().host());assertTrue(request.isHttps());connection.request=request;return connection;});
    SheetResponse response=http.execute(new SheetRequest("GET",read().getString("path"),null),"synthetic-native-token",()->true);assertEquals(302,response.getStatus());assertEquals("{}",response.getBody().toString());assertEquals("Bearer synthetic-native-token",connection.request.header("Authorization"));assertTrue(connection.cancelled);
    OkHttpClient client=HttpsGradeSheetsTransport.Companion.client();assertFalse(client.followRedirects());assertFalse(client.followSslRedirects());assertFalse(client.retryOnConnectionFailure());assertTrue(client.interceptors().isEmpty());assertNull(client.cache());
  }
  @Test public void httpBoundaryCapsResponseAndChecksForeground()throws Exception{
    FakeCall connection=new FakeCall();connection.length=GradeSheetsPolicy.MAX_BYTES+1;HttpsGradeSheetsTransport http=new HttpsGradeSheetsTransport(request->{connection.request=request;return connection;});
    try{http.execute(new SheetRequest("GET",read().getString("path"),null),"synthetic",()->true);fail("Response cap");}catch(Exception expected){}assertTrue(connection.cancelled);
    final int[] opens={0};http=new HttpsGradeSheetsTransport(request->{opens[0]++;connection.request=request;return connection;});try{http.execute(new SheetRequest("GET",read().getString("path"),null),"synthetic",()->false);fail("Foreground required");}catch(Exception expected){}assertEquals(0,opens[0]);
  }
  @Test public void cancellationBeforeExecuteIsStickyInRealOkHttp()throws Exception{
    final int[] dns={0};OkHttpClient client=HttpsGradeSheetsTransport.Companion.client().newBuilder().dns(host->{dns[0]++;throw new java.net.UnknownHostException("No network allowed in test");}).build();
    HttpsGradeSheetsTransport http=new HttpsGradeSheetsTransport(request->{Call call=client.newCall(request);call.cancel();return call;});
    try{http.execute(new SheetRequest("GET",read().getString("path"),null),"synthetic",()->true);fail("Cancelled request");}catch(IOException expected){}assertEquals(0,dns[0]);
  }
  @Test public void failedAccountSwitchCannotReuseOldJournalWithNewToken()throws Exception{
    store.binding=binding();status();transport.response=new SheetResponse(500,new JSONObject(),0);connect();assertTrue(store.authorizationBlocked());assertEquals("authorization-required",status().getString("state"));int count=transport.calls;assertEquals("authorization-required",code(call("gradeSheetsRequest",read())));assertEquals(count,transport.calls);
  }
  @Test public void metadataIsBoundReadOnlyAndHasNoCallerFileId()throws Exception{
    store.binding=binding();status();transport.response=new SheetResponse(200,new JSONObject().put("version","123").put("modifiedTime","2026-01-01T00:00:00Z").put("owner","must-not-escape"),0);
    JSONObject version=(JSONObject)call("gradeSheetVersion",new JSONObject());assertEquals("123",version.getString("version"));assertEquals("www.googleapis.com",transport.last.getHost());assertEquals("/drive/v3/files/synthetic_sheet?fields=version,modifiedTime",transport.last.getPath());assertFalse(version.toString().contains("must-not-escape"));
    int count=transport.calls;assertEquals("invalid-request",code(call("gradeSheetVersion",new JSONObject().put("spreadsheetId","other"))));assertEquals(count,transport.calls);
  }
  @Test public void realSdkRequestExcludesOtherScopesAndDefersBackgroundResolution()throws Exception{
    TaskCompletionSource<AuthorizationResult> task=new TaskCompletionSource<>();final AuthorizationRequest[] requested={null};final int[] launches={0};
    AuthorizationClient sdk=(AuthorizationClient)java.lang.reflect.Proxy.newProxyInstance(AuthorizationClient.class.getClassLoader(),new Class<?>[]{AuthorizationClient.class},(proxy,method,args)->{if(method.getName().equals("authorize")){requested[0]=(AuthorizationRequest)args[0];return task.getTask();}throw new UnsupportedOperationException(method.getName());});
    GoogleGradeAuthorization google=new GoogleGradeAuthorization(activity,()->sdk,()->true,intent->{launches[0]++;return Unit.INSTANCE;});google.setForeground(true);
    final NativeAuthorizationResult[] output={null};google.authorize(true,result->{output[0]=result;return Unit.INSTANCE;});assertEquals(1,requested[0].getRequestedScopes().size());assertEquals(GoogleGradeAuthorization.DRIVE_FILE,requested[0].getRequestedScopes().get(0).getScopeUri());assertTrue(requested[0].getOptOutIncludingGrantedScopes());assertFalse(requested[0].isOfflineAccessRequested());assertNull(requested[0].getServerClientId());assertEquals(AuthorizationRequest.Prompt.SELECT_ACCOUNT,requested[0].getPrompt());
    google.setForeground(false);PendingIntent pending=PendingIntent.getActivity(activity,543,new Intent(activity,Activity.class),PendingIntent.FLAG_IMMUTABLE);
    task.setResult(new AuthorizationResult(null,null,null,Collections.emptyList(),null,pending));org.robolectric.shadows.ShadowLooper.idleMainLooper();assertEquals(0,launches[0]);assertNull(output[0]);google.setForeground(true);assertEquals(1,launches[0]);
    assertTrue(google.onActivityResult(GoogleGradeAuthorization.REQUEST_CODE,Activity.RESULT_CANCELED,null));assertEquals("cancelled",output[0].getError());google.setForeground(true);assertEquals(1,launches[0]);
  }
  @Test public void realSdkMissingScopeRejectsNativeToken()throws Exception{
    AuthorizationClient sdk=(AuthorizationClient)java.lang.reflect.Proxy.newProxyInstance(AuthorizationClient.class.getClassLoader(),new Class<?>[]{AuthorizationClient.class},(proxy,method,args)->Tasks.forResult(new AuthorizationResult(null,"synthetic-native-token",null,Collections.emptyList(),null,null)));
    GoogleGradeAuthorization google=new GoogleGradeAuthorization(activity,()->sdk,()->true,intent->{fail("No consent expected");return Unit.INSTANCE;});google.setForeground(true);final NativeAuthorizationResult[] output={null};google.authorize(false,result->{output[0]=result;return Unit.INSTANCE;});org.robolectric.shadows.ShadowLooper.idleMainLooper();assertEquals("authorization-required",output[0].getError());assertNull(output[0].getToken());
  }
  @Test public void reconnectBlockAndAtomicJournalBackupSurviveStoreRecreation()throws Exception{
    EncryptedGradeSyncStorage storage=encrypted();storage.bind(binding());storage.save(CONNECTION,envelope());storage.blockAuthorization();assertTrue(encrypted().authorizationBlocked());
    File base=new File(activity.getNoBackupFilesDir(),"grade-sync-v1/journal-"+CONNECTION+".bin");File backup=new File(base.getPath()+".bak");assertTrue(base.renameTo(backup));assertEquals(envelope().toString(),encrypted().load(CONNECTION).toString());
    storage.bind(new GradeSheetBinding("new_sheet","Assessments",OTHER));assertFalse(encrypted().authorizationBlocked());
  }
  @Test public void encryptedJournalReloadsInSeparateJvm()throws Exception{
    String root=System.getProperty("process.cache.dir");org.junit.Assume.assumeNotNull(root);
    android.content.ContextWrapper persistent=new android.content.ContextWrapper(activity){@Override public File getNoBackupFilesDir(){File directory=new File(root,"synthetic-grade-sync");directory.mkdirs();return directory;}};
    EncryptedGradeSyncStorage storage=new EncryptedGradeSyncStorage(persistent,cipher());
    if("seed".equals(System.getProperty("test.phase"))){storage.bind(binding());storage.save(CONNECTION,envelope());storage.blockAuthorization();}
    assertEquals(CONNECTION,storage.binding().getConnectionId());assertEquals(envelope().toString(),storage.load(CONNECTION).toString());assertTrue(storage.authorizationBlocked());
  }
  @Test public void httpQuotaClassifierReadsOnlyAllowlistedReasonsAndDropsBody()throws Exception{
    FakeCall connection=new FakeCall();connection.code=403;connection.input="{\"error\":{\"errors\":[{\"reason\":\"rateLimitExceeded\"}],\"sensitiveDiagnostic\":\"must-not-escape\"}}";
    final FakeCall quota=connection;HttpsGradeSheetsTransport http=new HttpsGradeSheetsTransport(request->{quota.request=request;return quota;});SheetResponse response=http.execute(new SheetRequest("GET",read().getString("path"),null),"synthetic",()->true);assertEquals(429,response.getStatus());assertEquals("{}",response.getBody().toString());
    connection=new FakeCall();connection.code=403;connection.input="{\"error\":{\"errors\":[{\"reason\":\"unknown reason containing rateLimitExceeded\"}]}}";
    final FakeCall permission=connection;http=new HttpsGradeSheetsTransport(request->{permission.request=request;return permission;});assertEquals(404,http.execute(new SheetRequest("GET",read().getString("path"),null),"synthetic",()->true).getStatus());
  }
  @Test public void storageBootstrapAndJournalSaveAreDispatchedOffUi()throws Exception{
    List<Runnable> disk=new ArrayList<>();gateway=new NativeGradeSyncGateway(activity,true,auth,store,transport,Runnable::run,disk::add);gateway.onResume();store.binding=binding();
    final Object[] output={null};gateway.call("saveGradeSyncState",new JSONObject().put("connectionId",CONNECTION).put("envelope",envelope()),value->{output[0]=value;return Unit.INSTANCE;});assertTrue(store.journals.isEmpty());assertEquals(1,disk.size());assertNull(output[0]);disk.get(0).run();assertEquals(2,disk.size());assertTrue(store.journals.isEmpty());disk.get(1).run();assertTrue(((JSONObject)output[0]).getBoolean("ok"));assertNotNull(store.journals.get(CONNECTION));
  }
  static class MemoryStorage implements GradeSyncStorage {
    GradeSheetBinding binding;boolean blocked=false;Map<String,JSONObject> journals=new HashMap<>();
    public String deviceId(){return "synthetic-device";}public GradeSheetBinding binding(){return binding;}public void bind(GradeSheetBinding b){binding=b;blocked=false;}public boolean authorizationBlocked(){return blocked;}public void blockAuthorization(){if(binding!=null)blocked=true;}
    public JSONObject load(String id){if(binding==null||!id.equals(binding.getConnectionId()))throw new IllegalArgumentException("connection-changed");return journals.get(id);}
    public void save(String id,JSONObject envelope){if(binding==null||!id.equals(binding.getConnectionId()))throw new IllegalArgumentException("connection-changed");journals.put(id,envelope);}
  }
  static class FakeAuthorization implements GradeAuthorization {
    boolean available=true,interactive=false,defer=false,closed=false;int calls,clears;String error;String token="synthetic-native-token";Function1<? super NativeAuthorizationResult,Unit> pending;
    public void setForeground(boolean value){}public boolean available(){return available;}
    public void authorize(boolean interactive,Function1<? super NativeAuthorizationResult,Unit> complete){calls++;this.interactive=interactive;pending=complete;if(!defer)finish();}
    public void pickSheet(Function1<? super NativeAuthorizationResult,Unit> complete){calls++;this.interactive=true;pending=complete;if(!defer){pending=null;complete.invoke(new NativeAuthorizationResult(error==null?token:null,error,"picked-sheet"));}}
    void finish(){if(pending!=null){Function1<? super NativeAuthorizationResult,Unit> callback=pending;pending=null;callback.invoke(new NativeAuthorizationResult(error==null?token:null,error));}}
    public boolean onActivityResult(int a,int b,Intent c){return false;}public void clearToken(String token){clears++;}public void close(){closed=true;}
  }
  static class FakeTransport implements GradeSheetsTransport {
    int calls,sideEffects,identityCalls;String identity="synthetic-account";boolean cancelled;SheetRequest last;SheetResponse response;
    public SheetResponse execute(SheetRequest request,String token,Function0<Boolean> active){if(!active.invoke())throw new IllegalStateException("offline");if(request.getPath().equals(GradeAccountIdentity.PATH)){identityCalls++;try{return new SheetResponse(200,new JSONObject().put("user",new JSONObject().put("permissionId",identity)),0);}catch(Exception error){throw new RuntimeException(error);}}calls++;if(!active.invoke())throw new IllegalStateException("offline");sideEffects++;last=request;
      if(response!=null)return response;try{return new SheetResponse(200,new JSONObject().put("spreadsheetId","synthetic_created").put("sheets",new JSONArray().put(new JSONObject().put("properties",new JSONObject().put("title","Assessments")))),0);}catch(Exception e){throw new RuntimeException(e);}}
    public void cancel(){cancelled=true;}
  }
  static class FakeCall implements Call {
    int code=200;long length=-1;String input="{}";boolean cancelled,executed;Request request;
    public Request request(){return request;}public boolean isExecuted(){return executed;}public boolean isCanceled(){return cancelled;}public void cancel(){cancelled=true;}public Call clone(){return new FakeCall();}public Timeout timeout(){return new Timeout();}public void enqueue(Callback callback){throw new UnsupportedOperationException();}
    public Response execute()throws IOException{executed=true;if(cancelled)throw new IOException("Cancelled");return new Response.Builder().request(request).code(code).message("Synthetic").protocol(Protocol.HTTP_1_1).body(new ResponseBody(){public MediaType contentType(){return MediaType.get("application/json");}public long contentLength(){return length;}public BufferedSource source(){return new Buffer().writeUtf8(input);}}).build();}
  }
}
