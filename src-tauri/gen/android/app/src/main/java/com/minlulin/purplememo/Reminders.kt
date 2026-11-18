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
import androidx.core.app.NotificationManagerCompat
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
 *
 * Two honesty rules ride on top of that. The notification is **private on the
 * lock screen**: the app is FLAG_SECURE everywhere else (decision 6), so a
 * readable lock-screen card is the one hole left in it. And a reminder the
 * phone refused to show is **not reported as delivered** — the app settles a row
 * from that report, so claiming delivery for a notification nobody saw would
 * settle it silently. See [deliver].
 */
object ReminderBridge {
    private const val TAG = "PurpleMemo"
    private const val PREFS = "purple_memo_reminders"
    private const val KEY_PENDING = "pending"
    private const val KEY_DELIVERED = "delivered"
    /**
     * Versioned because a channel's settings are immutable once created (see
     * [ensureChannel]): v1 was made without a lock-screen visibility, and no
     * later call can change that, so the honest fix is a new channel.
     */
    const val CHANNEL_ID = "purple_memo_reminders_v2"
    /** The pre-v2 channel: retired on the next contact, so its cards go with it. */
    private const val LEGACY_CHANNEL_ID = "purple_memo_reminders"

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

    /**
     * Create the reminder channel once, and retire the pre-v2 one.
     *
     * Alarms are unaffected by the rename: the channel is chosen when a
     * notification is *posted*, not when it is armed, so a reminder armed before
     * this change still fires and arrives on v2. Retiring v1 also cancels any
     * notification it posted — those cards are already on the lock screen and
     * cannot be recalled any other way.
     */
    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Reminders",
                NotificationManager.IMPORTANCE_HIGH,
            )
            channel.description = "Task and reminder alerts scheduled on this phone"
            channel.lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            manager.createNotificationChannel(channel)
        }
        if (manager.getNotificationChannel(LEGACY_CHANNEL_ID) != null) {
            manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
            Log.i(TAG, "retired the pre-v2 reminder channel")
        }
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

    /**
     * Post the notification for a fired alarm, and record device-local delivery
     * **only when it was actually shown**.
     *
     * The accounting is load-bearing: the id this records is what makes the app
     * settle a row without notifying a second time, so recording a reminder that
     * was never displayed deletes it — no notification, no in-app reminder, no
     * trace. A refusal therefore records nothing: the alarm is spent and dropped
     * from the armed set, and the row stays pending in the database, where the
     * app's own in-app poll settles it the next time the app is open.
     *
     * Returns whether the notification reached the user.
     */
    fun deliver(context: Context, id: Long, title: String, body: String): Boolean {
        ensureChannel(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        var refusal: String? = null
        if (manager == null) {
            refusal = "this device has no NotificationManager"
        } else {
            refusal = refusalReason(context)
            if (refusal == null) {
                try {
                    manager.notify(id.toInt(), buildNotification(context, id, title, body))
                } catch (e: SecurityException) {
                    // The grant can be revoked between the check and the call.
                    refusal = "the notification permission was refused"
                    Log.w(TAG, "notification refused for reminder $id", e)
                }
            }
        }
        // The alarm has fired either way, so it is no longer armed. Only a
        // notification the user could see may be reported as delivered.
        val store = prefs(context)
        val pending = readObject(store, KEY_PENDING)
        pending.remove(id.toString())
        if (refusal != null) {
            store.edit().putString(KEY_PENDING, pending.toString()).apply()
            Log.w(
                TAG,
                "reminder $id was not shown ($refusal); left pending for the in-app " +
                    "poll instead of being settled unseen",
            )
            return false
        }
        val delivered = store.getString(KEY_DELIVERED, null)
        val list = if (delivered == null) JSONArray() else JSONArray(delivered)
        list.put(id)
        store.edit()
            .putString(KEY_PENDING, pending.toString())
            .putString(KEY_DELIVERED, list.toString())
            .apply()
        Log.i(TAG, "delivered reminder $id at ${System.currentTimeMillis()}")
        return true
    }

    /**
     * The reminder notification: no content on the lock screen (decision 6).
     *
     * `VISIBILITY_PRIVATE` is what keeps the workspace out of a locked phone's
     * screen; the channel's `lockscreenVisibility` is the same policy applied to
     * a notification the channel did not create.
     */
    private fun buildNotification(
        context: Context,
        id: Long,
        title: String,
        body: String,
    ): android.app.Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(context)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setVisibility(android.app.Notification.VISIBILITY_PRIVATE)
            // Tapping the notification opens the app (before this, the tap
            // only dismissed it — there was no content intent at all).
            .setContentIntent(
                PendingIntent.getActivity(
                    context,
                    id.toInt(),
                    Intent(context, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP
                    },
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .build()
    }

    /**
     * Why a notification posted right now would not be seen, or null when it
     * would be.
     *
     * Both of these are *silent* refusals: a blocked app (no
     * `POST_NOTIFICATIONS` grant, or notifications off in Settings) and a muted
     * channel post nothing and throw nothing, so the `SecurityException` path
     * alone would still record them as delivered.
     */
    private fun refusalReason(context: Context): String? {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            return "notifications are turned off for Purple Memo"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = manager?.getNotificationChannel(CHANNEL_ID)
            if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) {
                return "the Reminders channel is muted"
            }
        }
        return null
    }

    /**
     * Re-arm the persisted reminders from their local `due` strings, in the zone
     * that is current now.
     *
     * Called for every event that stops the system holding the alarms (see
     * `BootReceiver`): a reboot or app update clears them outright, a timezone
     * move leaves each RTC alarm at its old instant — the wrong wall time — and
     * a new exact-alarm grant should upgrade the ones armed inexactly.
     *
     * Rows whose local time has already passed are not armed, and their pending
     * alarm is **cancelled**: after a timezone move, "already passed here" and
     * "still armed for the old instant" are different things, and letting the
     * stale one stand would notify at a time the user never asked for. Such a
     * row stays pending in the database for the app's in-app poll to settle.
     */
    fun rearm(context: Context, reason: String) {
        val pending = readObject(prefs(context), KEY_PENDING)
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val exact = exactAllowed(context)
        var rearmed = 0
        var dropped = 0
        val keys = pending.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val id = key.toLongOrNull() ?: continue
            val row = pending.optJSONObject(key) ?: continue
            val at = epochMillis(row.optString("due")) ?: continue
            if (at <= System.currentTimeMillis()) {
                cancel(context, manager, id)
                dropped += 1
                continue
            }
            schedule(context, manager, id, row, at, exact)
            rearmed += 1
        }
        Log.i(TAG, "re-armed $rearmed reminder(s) after $reason ($dropped past, dropped)")
    }

    /**
     * Forget every armed reminder and every delivery record. Called from the
     * Rust side when a factory reset has wiped the database: the alarms and
     * these preferences live OUTSIDE the database, so without this an old
     * reminder would still fire for a record that no longer exists — and,
     * reminder row ids restarting at 1 after the wipe, a stale delivered id
     * could settle a new reminder that never fired.
     */
    @JvmStatic
    fun clearAll() {
        val context = context() ?: return
        val manager = context.getSystemService(AlarmManager::class.java)
        val store = prefs(context)
        val pending = readObject(store, KEY_PENDING)
        val keys = pending.keys()
        while (keys.hasNext()) {
            val id = keys.next().toLongOrNull() ?: continue
            cancel(context, manager, id)
        }
        store.edit().clear().apply()
        Log.i(TAG, "reminder state cleared (reset)")
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

/**
 * `AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED`, API 31+.
 * Spelled out rather than referenced so this file does not touch a constant that
 * does not exist below that API level; on older releases the action never fires.
 */
private const val ACTION_EXACT_ALARM_CHANGED =
    "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED"

/**
 * Re-arms the persisted reminders after any event that stops the system holding
 * their alarms, so a reminder survives an update or a flight across timezones
 * instead of waiting for the app to be opened again.
 *
 * Each action is one of those events: a reboot drops every alarm, an app update
 * stops the package (which drops them too), a clock or timezone change leaves an
 * RTC alarm at an instant that is no longer the local time the user set, and a
 * newly granted exact-alarm permission should turn the inexact fallbacks into
 * exact alarms. The revocation direction sends no broadcast — the system cancels
 * the exact alarms itself, and the next sync re-arms them inexactly.
 *
 * The manifest's intent filter is what makes any of this arrive; its comment
 * records why each action is deliverable to a non-exported receiver.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val reason = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> "boot"
            Intent.ACTION_MY_PACKAGE_REPLACED -> "package replaced"
            Intent.ACTION_TIME_CHANGED -> "time set"
            Intent.ACTION_TIMEZONE_CHANGED -> "timezone changed"
            ACTION_EXACT_ALARM_CHANGED -> "exact-alarm permission"
            else -> return
        }
        ReminderBridge.rearm(context, reason)
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
     * Clear the clip unless a DIFFERENT value is positively read in its
     * place — a user who copied something else in the meantime must not lose
     * that copy.
     *
     * The subtle case is a read that yields nothing: an empty clip, or
     * Android 10+ refusing the read because the app holds no focus. That
     * refusal is exactly the copy-then-switch-away case this timer exists
     * for, so "cannot be read" must not be treated as "replaced" — the
     * sensitive value would stay on the clipboard indefinitely. Unverifiable
     * therefore clears too. The accepted cost: a value copied in ANOTHER app
     * while this one was unfocused is equally unreadable and is cleared with
     * it; an erased clipboard is recoverable, a leaked password is not.
     */
    private fun clearIfUnchanged(manager: ClipboardManager, text: String) {
        val now = try {
            val current = manager.primaryClip
            if (current != null && current.itemCount > 0) {
                current.getItemAt(0).text?.toString()
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }
        if (now != null && now != text) {
            Log.i(TAG, "sensitive clipboard left alone: it was replaced")
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                manager.clearPrimaryClip()
            } else {
                manager.setPrimaryClip(ClipData.newPlainText("", ""))
            }
            Log.i(TAG, "sensitive clipboard cleared after $CLEAR_DELAY_MS ms")
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
