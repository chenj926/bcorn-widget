package com.acorn.widget;

import static org.junit.Assert.*;
import android.app.Activity;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import java.time.Duration;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowSystemClock;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.shadows.ShadowWebView;

/** Executes native activity policy; JS decisions are supplied through the real callback boundary. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, qualifiers="mdpi", shadows=NativeBackPolicyTest.RecordingActivityShadow.class)
public class NativeBackPolicyTest {
  @Implements(Activity.class)
  public static class RecordingActivityShadow extends ShadowActivity {
    static int movedToBack;
    @Implementation protected boolean moveTaskToBack(boolean nonRoot) { movedToBack++; return super.moveTaskToBack(nonRoot); }
  }
  private ActivityController<MainActivity> controller;
  private MainActivity activity;
  private ShadowWebView web;
  @Before public void setup() {
    RecordingActivityShadow.movedToBack=0;
    ShadowToast.reset();
    ShadowSystemClock.advanceBy(Duration.ofSeconds(1));
    controller=Robolectric.buildActivity(MainActivity.class).create().start().resume();
    activity=controller.get();
    WebView webView=activity.findViewById(R.id.web_content);
    web=Shadows.shadowOf(webView);
  }
  @After public void cleanup() { if(!activity.isDestroyed()) controller.pause().stop().destroy(); }
  private ValueCallback<String> press() {
    activity.onBackPressed();
    assertTrue(web.getLastEvaluatedJavascript().contains("__acornNativeBackState"));
    ValueCallback<String> callback=web.getLastEvaluatedJavascriptCallback();
    assertNotNull(callback);
    return callback;
  }
  private void respond(boolean consumed,long interaction) { press().onReceiveValue("{\"consumed\":"+consumed+",\"interaction\":"+interaction+"}"); }
  @Test public void consumedBackDoesNotExitOrShowRootToast() {
    respond(true,10);
    assertEquals(0,RecordingActivityShadow.movedToBack);
    assertEquals(0,ShadowToast.shownToastCount());
    assertFalse(activity.isFinishing());
  }
  @Test public void rootBackRequiresSecondPressWithinTwoSeconds() {
    respond(false,10);
    assertEquals("再按一次返回桌面",ShadowToast.getTextOfLatestToast());
    assertEquals(0,RecordingActivityShadow.movedToBack);
    ShadowSystemClock.advanceBy(Duration.ofMillis(500));
    respond(false,10);
    assertEquals(1,RecordingActivityShadow.movedToBack);
    assertFalse(activity.isFinishing());
  }
  @Test public void interactionSerialChangePreventsExit() {
    respond(false,10);
    ShadowSystemClock.advanceBy(Duration.ofMillis(500));
    respond(false,11);
    assertEquals(0,RecordingActivityShadow.movedToBack);
    assertEquals(2,ShadowToast.shownToastCount());
    ShadowSystemClock.advanceBy(Duration.ofMillis(500));
    respond(false,11);
    assertEquals(1,RecordingActivityShadow.movedToBack);
  }
  @Test public void pendingJavascriptBackRequestsAreDeduplicated() {
    ValueCallback<String> pending=press();
    activity.onBackPressed();
    assertSame(pending,web.getLastEvaluatedJavascriptCallback());
    assertEquals(0,RecordingActivityShadow.movedToBack);
    pending.onReceiveValue("{\"consumed\":true,\"interaction\":5}");
    assertNotSame(pending,press());
  }
  @Test public void consumedInteractionClearsPreviouslyArmedRootBack() {
    respond(false,10);
    ShadowSystemClock.advanceBy(Duration.ofMillis(100));
    respond(true,10);
    ShadowSystemClock.advanceBy(Duration.ofMillis(100));
    respond(false,10);
    assertEquals(0,RecordingActivityShadow.movedToBack);
    assertEquals(2,ShadowToast.shownToastCount());
  }
  @Test public void expiredRootBackWindowDoesNotExit() {
    respond(false,10);
    ShadowSystemClock.advanceBy(Duration.ofMillis(2001));
    respond(false,10);
    assertEquals(0,RecordingActivityShadow.movedToBack);
    assertEquals(2,ShadowToast.shownToastCount());
  }
  @Test public void typingKeyClearsPreviouslyArmedRootBack() {
    respond(false,10);
    activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A));
    ShadowSystemClock.advanceBy(Duration.ofMillis(100));
    respond(false,10);
    assertEquals(0,RecordingActivityShadow.movedToBack);
    assertEquals(2,ShadowToast.shownToastCount());
  }
  @Test public void callbackAfterActivityDestructionDoesNotExitOrToast() {
    ValueCallback<String> pending=press();
    controller.pause().stop().destroy();
    pending.onReceiveValue("{\"consumed\":false,\"interaction\":10}");
    assertEquals(0,RecordingActivityShadow.movedToBack);
    assertEquals(0,ShadowToast.shownToastCount());
  }
}
