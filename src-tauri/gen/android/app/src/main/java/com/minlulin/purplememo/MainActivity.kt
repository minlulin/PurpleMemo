package com.minlulin.purplememo

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The reminder scheduler and the sensitive clipboard need an application
    // context that outlives any single activity; hand it over before the
    // webview can invoke a command.
    ReminderBridge.install(applicationContext)
    SensitiveClipboard.install(applicationContext)
  }
}
