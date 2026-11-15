# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Purple Memo: the Rust side reaches these two bridge classes by name over
# JNI (src-tauri/src/reminders.rs) — ReminderBridge.sync / exactState /
# openExactAlarmSettings / clearAll and SensitiveClipboard.copy. Nothing in
# Java or Kotlin references them, so without these keeps R8 strips or renames
# them in release builds and every reminder and sensitive-copy call fails at
# runtime (silently: the JS side treats a failed sync as best-effort).
-keep class com.minlulin.purplememo.ReminderBridge { public static *; }
-keep class com.minlulin.purplememo.SensitiveClipboard { public static *; }
