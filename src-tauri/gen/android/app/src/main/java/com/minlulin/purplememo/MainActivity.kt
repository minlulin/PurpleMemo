package com.minlulin.purplememo

import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Whole-app screenshot block (docs/ANDROID_DESIGN.md decision 6): FLAG_SECURE
    // keeps the workspace out of screenshots, the recents thumbnail and screen
    // recording. Set before the super call so the window is flagged before the
    // webview is attached — there is no frame in which the app could be captured.
    window.setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE,
    )
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Keyboard-aware layout. The window is edge-to-edge and Android 15+ ignores
    // `adjustResize` for edge-to-edge apps, so without this the webview keeps its
    // full height when the keyboard opens and the tab bar sits behind the keys.
    // Padding the content host by the IME inset shrinks the webview's viewport
    // instead — the same geometry `adjustResize` used to produce — so the CSS
    // shell measures its height against the space above the keyboard.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      if (view.paddingBottom != ime) {
        view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, ime)
      }
      insets
    }
    ViewCompat.requestApplyInsets(content)
    // The reminder scheduler and the sensitive clipboard need an application
    // context that outlives any single activity; hand it over before the
    // webview can invoke a command.
    ReminderBridge.install(applicationContext)
    SensitiveClipboard.install(applicationContext)
  }
}
