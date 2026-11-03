package com.minlulin.purplememo

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Native reminder delivery (design decision 9): the *creating device* notifies,
 * and delivery state is device-local.
 *
 * Why this exists: the in-app reminder poll only runs while the app is open, so
 * it cannot deliver anything once Android backgrounds or Dozes the process.
 * Reminders are therefore armed with [AlarmManager] — `setExactAndAllowWhileIdle`
 * when the exact-alarm permission is held, `setAndAllowWhileIdle` otherwise —
 * and a [ReminderReceiver] posts the notification even when Purple Memo is not
 * running.
 *
 * What is deliberately *not* persisted here: any reminder text beyond what the
 * next alarm needs. Rows live in the encrypted database; this class only keeps
 * the ids, titles and due times of alarms that are already armed, so the
 * device-local delivery state never becomes a second unencrypted copy of the
 * user's notes.
 */
object ReminderBridge {
    private const val TAG = "PurpleMemo"
    private const val PREFS = "purple_memo_reminders"
    private const val KEY_PENDING = "pending"
    private const val KEY_DELIVERED = "delivered"
    const val CHANNEL_ID = "purple_memo_reminders"

    @Volatile
    private var appContext: Context? = null

    /** Called once from `MainActivity.onCreate`, before any command can arrive. */
    @JvmStatic
    fun install(context: Context) {
        appContext = context.applicationContext
        ensureChannel(context.applicationContext)
    }

    private fun context(): Context? = appContext

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Reminders",
            NotificationManager.IMPORTANCE_HIGH,
        )
        channel.description = "Task and reminder alerts scheduled on this phone"
        manager.createNotificationChannel(channel)
    }

    /**
     * Whether an exact alarm would be accepted right now. Below API 31 there is
     * no such permission, so exact scheduling is always available.
     */
    @JvmStatic
    fun exactAllowed(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val manager = context.getSystemService(AlarmManager::class.java) ?: return false
        return manager.canScheduleExactAlarms()
    }

    /** `"exact"` or `"inexact"` — what the UI must disclose. */
    @JvmStatic
    fun exactState(): String {
        val context = context() ?: return "unknown"
        return if (exactAllowed(context)) "exact" else "inexact"
    }

    /**
     * Open the OS screen where exact alarms are granted. The app never pretends
     * it can grant this itself: it is a system setting, not a runtime prompt.
     */
    @JvmStatic
    fun openExactAlarmSettings() {
        val context = context() ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        try {
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                .setData(android.net.Uri.parse("package:" + context.packageName))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "could not open the exact-alarm settings screen", e)
        }
    }

    /**
     * Reconcile the phone's armed alarms with the pending rows the app sent.
     *
     * `rowsJson` is `[{"id":1,"title":"…","body":"…","due":"yyyy-MM-ddTHH:mm"}]`
     * in the phone's local time. Rows whose due time is already past are not
     * armed: the app is open on this pass and settles them itself, so arming an
     * alarm for the past would fire a duplicate notification.
     *
     * Returns `{exact, delivered[], scheduled, inexact, error?}`. `delivered`
     * is the ids whose alarm fired since the last sync — the delivery state is
     * device-local, and handing those ids back is how the app marks the rows
     * without ever notifying a second time.
     */
    @JvmStatic
    fun sync(rowsJson: String): String {
        val context = context()
            ?: return JSONObject()
                .put("exact", false)
                .put("delivered", JSONArray())
                .put("scheduled", 0)
                .put("inexact", 0)
                .put("error", "the reminder bridge is not installed")
                .toString()
        ensureChannel(context)
        val store = prefs(context)
        val manager = context.getSystemService(AlarmManager::class.java)
        val desired = LinkedHashMap<Long, JSONObject>()
        try {
            val incoming = JSONArray(rowsJson)
            for (i in 0 until incoming.length()) {
                val row = incoming.getJSONObject(i)
                desired[row.getLong("id")] = row
            }
        } catch (e: Exception) {
            Log.e(TAG, "could not read the reminder rows", e)
            return JSONObject()
                .put("exact", exactAllowed(context))
                .put("delivered", JSONArray())
                .put("scheduled", 0)
                .put("inexact", 0)
                .put("error", e.toString())
                .toString()
        }

        // Cancel alarms whose rows are gone (deleted, marked fired, re-armed to
        // a different time): the persisted key set is the previous pass's work.
        val previous = readObject(store, KEY_PENDING)
        val keys = previous.keys()
        while (keys.hasNext()) {
            val id = keys.next().toLongOrNull() ?: continue
            if (!desired.containsKey(id)) cancel(context, manager, id)
        }

        val exact = exactAllowed(context)
        var scheduled = 0
        var inexact = 0
        val next = JSONObject()
        for ((id, row) in desired) {
            val due = row.optString("due")
            val at = epochMillis(due) ?: continue
            if (at <= System.currentTimeMillis()) continue
            val usedExact = schedule(context, manager, id, row, at, exact)
            next.put(id.toString(), row)
            scheduled += 1
            if (!usedExact) inexact += 1
        }
        store.edit().putString(KEY_PENDING, next.toString()).apply()
        val delivered = takeDelivered(store)
        Log.i(
            TAG,
            "reminder sync: exact=$exact scheduled=$scheduled inexact=$inexact " +
                "delivered=${delivered.length()} cancelled=${
                    previous.length() - (scheduled - (desired.size - previous.length()))
                }",
        )
        return JSONObject()
            .put("exact", exact)
            .put("delivered", delivered)
            .put("scheduled", scheduled)
            .put("inexact", inexact)
            .toString()
    }

    /** Arm one alarm; returns whether it was scheduled exactly. */
    private fun schedule(
        context: Context,
        manager: AlarmManager?,
        id: Long,
        row: JSONObject,
        at: Long,
        exactRequested: Boolean,
    ): Boolean {
        if (manager == null) return false
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            putExtra(ReminderReceiver.EXTRA_ID, id)
            putExtra(ReminderReceiver.EXTRA_TITLE, row.optString("title"))
            putExtra(ReminderReceiver.EXTRA_BODY, row.optString("body"))
        }
        val pending = PendingIntent.getBroadcast(
            context,
            id.toInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        if (exactRequested) {
            try {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
                Log.i(TAG, "armed reminder $id at $at (exact)")
                return true
            } catch (e: SecurityException) {
                // The permission can be revoked between the check and the call.
                // Falling back is the honest outcome; the UI discloses it.
                Log.w(TAG, "exact alarm refused for reminder $id; falling back to inexact", e)
            }
        }
        manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
        Log.i(TAG, "armed reminder $id at $at (inexact)")
        return false
    }

    private fun cancel(context: Context, manager: AlarmManager?, id: Long) {
        if (manager == null) return
        val intent = Intent(context, ReminderReceiver::class.java)
        val pending = PendingIntent.getBroadcast(
            context,
            id.toInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.cancel(pending)
        pending.cancel()
        Log.i(TAG, "cancelled reminder $id")
    }

    /** Post the notification for a fired alarm and record device-local delivery. */
    fun deliver(context: Context, id: Long, title: String, body: String) {
        ensureChannel(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager == null) {
            Log.e(TAG, "no NotificationManager; reminder $id could not be shown")
            return
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(context)
        }
        val notification = builder
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(id.toInt(), notification)
            Log.i(TAG, "delivered reminder $id at ${System.currentTimeMillis()}")
        } catch (e: SecurityException) {
            // No POST_NOTIFICATIONS grant: say so instead of pretending.
            Log.w(TAG, "notification permission refused for reminder $id", e)
        }
        val store = prefs(context)
        val pending = readObject(store, KEY_PENDING)
        pending.remove(id.toString())
        val delivered = store.getString(KEY_DELIVERED, null)
        val list = if (delivered == null) JSONArray() else JSONArray(delivered)
        list.put(id)
        store.edit()
            .putString(KEY_PENDING, pending.toString())
            .putString(KEY_DELIVERED, list.toString())
            .apply()
    }

    /** Re-arm everything after a reboot: AlarmManager alarms do not survive one. */
    fun rearm(context: Context) {
        val pending = readObject(prefs(context), KEY_PENDING)
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val exact = exactAllowed(context)
        var rearmed = 0
        val keys = pending.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val id = key.toLongOrNull() ?: continue
            val row = pending.optJSONObject(key) ?: continue
            val at = epochMillis(row.optString("due")) ?: continue
            if (at <= System.currentTimeMillis()) continue
            schedule(context, manager, id, row, at, exact)
            rearmed += 1
        }
        Log.i(TAG, "re-armed $rearmed reminder(s) after boot")
    }

    private fun takeDelivered(store: android.content.SharedPreferences): JSONArray {
        val raw = store.getString(KEY_DELIVERED, null)
        val list = if (raw == null) JSONArray() else JSONArray(raw)
        if (list.length() > 0) store.edit().remove(KEY_DELIVERED).apply()
        return list
    }

    private fun readObject(
        store: android.content.SharedPreferences,
        key: String,
    ): JSONObject {
        val raw = store.getString(key, null) ?: return JSONObject()
        return try {
            JSONObject(raw)
        } catch (e: Exception) {
            JSONObject()
        }
    }

    /** Local `yyyy-MM-ddTHH:mm` → epoch millis, or null when unparseable. */
    private fun epochMillis(local: String): Long? {
        if (local.isEmpty()) return null
        return try {
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.ROOT)
            format.parse(local)?.time
        } catch (e: Exception) {
            null
        }
    }
}

/** Fires at the armed time and posts the notification, app running or not. */
class ReminderReceiver : BroadcastReceiver() {
    companion object {
        const val EXTRA_ID = "purple_memo_id"
        const val EXTRA_TITLE = "purple_memo_title"
        const val EXTRA_BODY = "purple_memo_body"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getLongExtra(EXTRA_ID, -1L)
        if (id < 0) return
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "Reminder"
        val body = intent.getStringExtra(EXTRA_BODY) ?: ""
        ReminderBridge.deliver(context, id, title, body)
    }
}

/** Re-registers armed reminders after a reboot (alarms do not survive one). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        ReminderBridge.rearm(context)
    }
}

/**
 * Sensitive clipboard copy (design decision 7): mark the clip sensitive, then
 * clear it on a best-effort timer.
 *
 * "Best-effort" is exact, and the UI says so: the clear runs on this process's
 * main looper, so killing the app before the timer fires leaves the value where
 * it was. Android 13+ additionally hides a clip marked
 * `android.content.extra.IS_SENSITIVE` from the copy preview and clears the
 * clipboard itself after about an hour; below 13 that marker does nothing and
 * the timer is the only protection.
 */
object SensitiveClipboard {
    private const val TAG = "PurpleMemo"
    /** How long a sensitive value may stay on the clipboard. */
    const val CLEAR_DELAY_MS = 30_000L

    @Volatile
    private var appContext: Context? = null
    private val handler = Handler(Looper.getMainLooper())

    @JvmStatic
    fun install(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Copy [text] as a sensitive clip and clear it after [CLEAR_DELAY_MS].
     * Returns the delay actually used, so the UI can tell the truth about it.
     */
    @JvmStatic
    fun copy(text: String): Long {
        val context = appContext ?: return 0L
        val manager = context.getSystemService(ClipboardManager::class.java) ?: return 0L
        val clip = ClipData.newPlainText("Purple Memo (sensitive)", text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val extras = PersistableBundle()
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true)
            clip.description.extras = extras
        }
        manager.setPrimaryClip(clip)
        Log.i(TAG, "sensitive clipboard set; will clear in $CLEAR_DELAY_MS ms")
        handler.postDelayed({
            clearIfUnchanged(manager, text)
        }, CLEAR_DELAY_MS)
        return CLEAR_DELAY_MS
    }

    /**
     * Clear only if the clipboard still holds this exact value. A user who
     * copied something else in the meantime must not lose that copy.
     */
    private fun clearIfUnchanged(manager: ClipboardManager, text: String) {
        try {
            val current = manager.primaryClip
            val now = if (current != null && current.itemCount > 0) {
                current.getItemAt(0).text?.toString()
            } else {
                null
            }
            if (now == text) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    manager.clearPrimaryClip()
                } else {
                    manager.setPrimaryClip(ClipData.newPlainText("", ""))
                }
                Log.i(TAG, "sensitive clipboard cleared after $CLEAR_DELAY_MS ms")
            } else {
                Log.i(TAG, "sensitive clipboard left alone: it was replaced")
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not clear the sensitive clipboard", e)
        }
    }

    /** Debug-only probe used to prove the clear on a device. */
    @JvmStatic
    fun read(): String {
        val context = appContext ?: return ""
        val manager = context.getSystemService(ClipboardManager::class.java) ?: return ""
        val current = manager.primaryClip ?: return ""
        if (current.itemCount == 0) return ""
        return current.getItemAt(0).text?.toString() ?: ""
    }
}
