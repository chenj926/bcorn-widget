package com.acorn.widget;

import static org.junit.Assert.*;
import android.graphics.Insets;
import android.graphics.Rect;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ActivityController;

/** Real native root geometry. This does not claim to execute the Chromium HTML engine. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="mdpi")
public class NativeInsetsTest {
  private void layout(View root) {
    root.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(844,View.MeasureSpec.EXACTLY));
    root.layout(0,0,390,844);
  }
  @Test public void systemBarsCutoutAndKeyboardInsetWebViewViewportExactlyOnce() {
    try(ActivityController<MainActivity> controller=Robolectric.buildActivity(MainActivity.class).create().start().resume()) {
      MainActivity activity=controller.get();
      View root=activity.findViewById(R.id.web_root);
      WebView web=activity.findViewById(R.id.web_content);
      // Robolectric's dummy WebView provider does not implement its native setFrame override.
      // A plain match-parent sibling verifies the real FrameLayout viewport geometry.
      View viewport=new View(activity);
      ((android.widget.FrameLayout)root).addView(viewport,new android.widget.FrameLayout.LayoutParams(-1,-1));
      assertEquals(-1,web.getLayoutParams().width);assertEquals(-1,web.getLayoutParams().height);
      WindowInsets bars=new WindowInsets.Builder().setInsets(WindowInsets.Type.systemBars(),Insets.of(0,24,0,24))
          .setInsets(WindowInsets.Type.displayCutout(),Insets.of(8,32,0,0)).setVisible(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout(),true).build();
      assertEquals(32,bars.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()).top);
      assertTrue(root.dispatchApplyWindowInsets(bars).isConsumed());
      assertEquals(32,root.getPaddingTop());layout(root);
      assertEquals(32,viewport.getTop());assertEquals(8,viewport.getLeft());assertEquals(820,viewport.getBottom());
      assertEquals(0,web.getPaddingTop());assertEquals(0,web.getPaddingBottom());
      root.dispatchApplyWindowInsets(bars);layout(root);
      assertEquals(32,viewport.getTop());assertEquals(820,viewport.getBottom());
      WindowInsets keyboard=new WindowInsets.Builder(bars).setInsets(WindowInsets.Type.ime(),Insets.of(0,0,0,300)).setVisible(WindowInsets.Type.ime(),true).build();
      root.dispatchApplyWindowInsets(keyboard);layout(root);
      assertEquals(544,viewport.getBottom());assertEquals(32,viewport.getTop());
      root.dispatchApplyWindowInsets(bars);layout(root);
      assertEquals(820,viewport.getBottom());
      WindowInsets landscape=new WindowInsets.Builder().setInsets(WindowInsets.Type.systemBars(),Insets.of(0,24,40,0)).setVisible(WindowInsets.Type.systemBars(),true).build();
      root.dispatchApplyWindowInsets(landscape);layout(root);
      assertEquals(0,viewport.getLeft());assertEquals(350,viewport.getRight());assertEquals(24,viewport.getTop());
    }
  }
}
