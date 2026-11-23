package com.minlulin.purplememo

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Fingerprint/face unlock: the phone's *additional* unlock path beside the PIN.
 *
 * What this is not: a new lock boundary. The database key is unwrapped at boot,
 * before this screen exists, so a `success` here is the same evidence a correct
 * PIN is — it can never open the database by itself, and the PIN stays the root
 * unlock and the permanent fallback. The Keystore wrapping is untouched.
 *
 * Two things make this different from [ReminderBridge], and both are deliberate:
 *
 * * **It needs the live Activity.** `BiometricPrompt` attaches a fragment to a
 *   `FragmentActivity`'s `FragmentManager`; the application context cannot host
 *   a prompt. `MainActivity` registers itself here (weak reference, refreshed on
 *   create and resume) rather than handing over an application context.
 * * **It is interactive and asynchronous.** The reminder helpers are synchronous
 *   calls; a prompt answers through a callback whenever the human does something.
 *   So the prompt is posted to the main thread and the calling (Rust) thread
 *   blocks on a latch: the UI thread is never blocked, which is what keeps this
 *   from being an ANR.
 *
 * Every outcome is a result string — `success`, `cancelled`, `failed`,
 * `lockout`, `unavailable` — because nothing may be thrown across JNI. The
 * prompt is prompt-only (no `CryptoObject`) and `BIOMETRIC_STRONG` only: the
 * phone's own PIN/pattern is deliberately *not* an allowed fallback, or it would
 * quietly replace the app's PIN with the device credential.
 */
object BiometricBridge {
    private const val TAG = "PurpleMemo"

    /**
     * The prompt's escape hatch; the app PIN is what it leads back to.
     *
     * Only a fallback: the renderer supplies the label in the app's own
     * language, because this class cannot read the encrypted settings row that
     * holds that choice.
     */
    private const val PIN_BUTTON = "Use PIN"

    /**
     * How long the calling thread waits for an answer before giving up.
     *
     * A prompt normally ends itself — the system closes it when the screen turns
     * off — but an Activity going away can swallow the callback, and a JNI thread
     * waiting forever is a leak. A wait that ends with no answer reports
     * `cancelled`: no unlock happened, and the prompt that is still on screen
     * answers into a waiter nobody is listening to.
     */
    private const val PROMPT_TIMEOUT_SECONDS = 300L

    @Volatile
    private var attached: WeakReference<FragmentActivity>? = null

    /** True while a prompt is up, so two callers cannot race one Activity. */
    @Volatile
    private var prompting = false

    private val main = Handler(Looper.getMainLooper())

    /** Called from `MainActivity` on create and resume. */
    @JvmStatic
    fun attach(activity: FragmentActivity) {
        attached = WeakReference(activity)
    }

    private fun currentActivity(): FragmentActivity? =
        attached?.get()?.takeIf { !it.isFinishing && !it.isDestroyed }

    /**
     * `available`, `none-enrolled`, `no-hardware` or `unavailable` — whether a
     * strong-biometric prompt could be shown right now.
     */
    @JvmStatic
    fun status(): String {
        val activity = currentActivity() ?: return "unavailable"
        return try {
            val manager = BiometricManager.from(activity)
            when (
                manager.canAuthenticate(
                    BiometricManager.Authenticators.BIOMETRIC_STRONG,
                )
            ) {
                BiometricManager.BIOMETRIC_SUCCESS -> "available"
                BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "none-enrolled"
                BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no-hardware"
                else -> "unavailable"
            }
        } catch (e: Exception) {
            Log.w(TAG, "the biometric capability check failed", e)
            "unavailable"
        }
    }

    /**
     * Show the prompt and report what it did.
     *
     * `title` and `negativeButton` are the dialog's words, passed in by the
     * renderer from the app's catalogue; a blank one falls back to the app label
     * / [PIN_BUTTON].
     *
     * Called from a non-UI thread (the Rust side runs it on a blocking thread),
     * so blocking here is safe. A phone with nothing enrolled or no hardware is
     * turned away by [status] instead of being shown a prompt that can only fail.
     */
    @JvmStatic
    fun authenticate(title: String, negativeButton: String): String {
        val activity = currentActivity() ?: return "unavailable"
        if (status() != "available") return "unavailable"
        if (prompting) {
            Log.w(TAG, "a biometric prompt is already showing")
            return "unavailable"
        }
        prompting = true
        try {
            val waiter = Waiter()
            if (!main.post { show(activity, waiter, title, negativeButton) }) {
                Log.w(TAG, "the main thread did not accept the biometric prompt")
                return "unavailable"
            }
            return waiter.await(PROMPT_TIMEOUT_SECONDS)
        } finally {
            prompting = false
        }
    }

    /** Build and show the prompt; any failure settles the waiter, never throws. */
    private fun show(
        activity: FragmentActivity,
        waiter: Waiter,
        title: String,
        negativeButton: String,
    ) {
        try {
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                callback(waiter),
            )
            prompt.authenticate(promptInfo(activity, title, negativeButton))
        } catch (e: Exception) {
            Log.w(TAG, "the biometric prompt could not be shown", e)
            waiter.settle("unavailable")
        }
    }

    private fun promptInfo(
        activity: FragmentActivity,
        title: String,
        negativeButton: String,
    ): BiometricPrompt.PromptInfo {
        // The app's own label is only a last resort: the renderer's title is the
        // one in the language the user chose inside the app.
        val heading = title.ifBlank {
            try {
                activity.packageManager
                    .getApplicationLabel(activity.applicationInfo)
                    .toString()
            } catch (e: Exception) {
                "Purple Memo"
            }
        }
        return BiometricPrompt.PromptInfo.Builder()
            .setTitle(heading)
            // Required whenever the device credential is not allowed, and the
            // honest escape: this button leads back to the app's PIN.
            .setNegativeButtonText(negativeButton.ifBlank { PIN_BUTTON })
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG,
            )
            .build()
    }

    /**
     * The prompt's answers, translated to the five result strings.
     *
     * `onAuthenticationFailed` is deliberately not overridden: it reports one
     * rejected fingerprint/face attempt and the prompt stays up for the next one.
     * The system's own attempt limit ends the prompt with `ERROR_LOCKOUT`, which
     * is where a lockout actually comes from.
     */
    private fun callback(waiter: Waiter) =
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(
                result: BiometricPrompt.AuthenticationResult,
            ) {
                waiter.settle("success")
            }

            override fun onAuthenticationError(
                errorCode: Int,
                errString: CharSequence,
            ) {
                Log.i(TAG, "the biometric prompt ended with $errorCode: $errString")
                val outcome = when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                    BiometricPrompt.ERROR_CANCELED -> "cancelled"
                    BiometricPrompt.ERROR_LOCKOUT,
                    BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "lockout"
                    BiometricPrompt.ERROR_HW_NOT_PRESENT,
                    BiometricPrompt.ERROR_HW_UNAVAILABLE,
                    BiometricPrompt.ERROR_NO_BIOMETRICS -> "unavailable"
                    else -> "failed"
                }
                waiter.settle(outcome)
            }
        }

    /** One prompt's outcome, handed from the callback to the waiting thread. */
    private class Waiter {
        private val result = AtomicReference("failed")
        private val answered = AtomicBoolean(false)
        private val latch = CountDownLatch(1)

        /** Record the answer; the first one wins and a late callback is ignored. */
        fun settle(outcome: String) {
            if (answered.compareAndSet(false, true)) {
                result.set(outcome)
                latch.countDown()
            }
        }

        /** The outcome, or `cancelled` when the prompt never answered in time. */
        fun await(seconds: Long): String = try {
            if (latch.await(seconds, TimeUnit.SECONDS)) result.get() else "cancelled"
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.w(TAG, "the wait for the biometric prompt was interrupted", e)
            "cancelled"
        }
    }
}
