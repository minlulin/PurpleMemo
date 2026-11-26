// The phone's reminders panel: one repeating reminder per note, with the
// repeat labels and the future/ready rules in `lib/mobileSettings.ts`.

import { isPermissionGranted } from "@tauri-apps/plugin-notification";
import { useCallback, useState } from "react";
import { localDeviceId, settingsRepo, tasksRepo } from "../../data/app.ts";
import {
  isAndroidPlatform,
  syncAndroidReminders,
} from "../../lib/android-reminders.ts";
import { localISODateTime } from "../../lib/dates.ts";
import {
  reminderDraftReady,
  reminderIsFuture,
} from "../../lib/mobileSettings.ts";
import { remindableHere } from "../../lib/sync/reminderDelivery.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";

// -- Reminders ---------------------------------------------------------------

type ReminderRepeat = "none" | "daily" | "weekly" | "monthly";

const REMINDER_REPEATS: readonly ReminderRepeat[] = [
  "none",
  "daily",
  "weekly",
  "monthly",
];

const REPEAT_LABEL_KEYS: Record<
  ReminderRepeat,
  | "mobile.reminders.repeatNone"
  | "mobile.reminders.repeatDaily"
  | "mobile.reminders.repeatWeekly"
  | "mobile.reminders.repeatMonthly"
> = {
  none: "mobile.reminders.repeatNone",
  daily: "mobile.reminders.repeatDaily",
  weekly: "mobile.reminders.repeatWeekly",
  monthly: "mobile.reminders.repeatMonthly",
};

/**
 * Reminders on the Tasks page (Phase B session 4).
 *
 * The list is the pending rows the OS has been handed; creating one arms it
 * immediately instead of waiting for the app's next reconcile pass, because
 * this device is the one that notifies and the user just asked for that time.
 * There is no edit and no delete here — mobile is view + add only.
 */
export function RemindersPanel() {
  const t = useT();
  const load = useCallback(() => tasksRepo.listReminders(false), []);
  const { data, failed, reload } = useLoad(load);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [repeat, setRepeat] = useState<ReminderRepeat>("none");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    const draft = { title, remindAt };
    if (!reminderDraftReady(draft)) {
      setError(t("mobile.reminders.incomplete"));
      return;
    }
    if (!reminderIsFuture(draft.remindAt, localISODateTime(new Date()))) {
      setError(t("mobile.reminders.past"));
      return;
    }
    setBusy(true);
    try {
      await tasksRepo.createReminder({
        title: title.trim(),
        remindAt: draft.remindAt,
        repeat,
        note: "",
      });
      const granted = await isPermissionGranted().catch(() => false);
      if (isAndroidPlatform()) {
        // Hand the OS the new alarm now. A reconcile failure keeps the row —
        // the next app tick arms it — so it must not fail the save.
        try {
          // §13.1: the alarm is armed only for reminders this device created.
          const rows = remindableHere(
            await tasksRepo.listReminders(false),
            await localDeviceId(),
          );
          const preview = await settingsRepo
            .getNotificationPreview()
            .catch(() => false);
          const { outcomes } = await syncAndroidReminders(
            rows,
            preview,
            localISODateTime(new Date()),
          );
          if (outcomes.length > 0) await tasksRepo.settleReminders(outcomes);
        } catch {
          // Best effort, exactly like the app-level sync.
        }
      }
      setTitle("");
      setRemindAt("");
      setRepeat("none");
      setNotice(
        granted
          ? t("mobile.reminders.added")
          : t("mobile.reminders.notifyBlocked"),
      );
      reload();
    } catch {
      setError(t("mobile.reminders.addFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mobile-section-kicker">{t("mobile.reminders.heading")}</p>
      <p className="mobile-note">{t("mobile.reminders.subtitle")}</p>
      <LoadMessage failed={failed} />
      {data !== null && data.length === 0 ? (
        <EmptyState>{t("mobile.reminders.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.reminders.listAria")}>
        {(data ?? []).map((reminder) => (
          <li key={reminder.id} className="mobile-row">
            <span className="mobile-row-text">
              {reminder.title}
              <span className="mobile-row-meta">
                {reminder.remind_at} · {t(REPEAT_LABEL_KEYS[reminder.repeat])}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mobile-card">
        <label className="mobile-field">
          <span>{t("mobile.reminders.title")}</span>
          <input
            className="input"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.reminders.when")}</span>
          <input
            className="input"
            type="datetime-local"
            value={remindAt}
            onChange={(event) => setRemindAt(event.target.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.reminders.repeat")}</span>
          <select
            className="input"
            value={repeat}
            onChange={(event) =>
              setRepeat(event.target.value as ReminderRepeat)
            }
          >
            {REMINDER_REPEATS.map((value) => (
              <option key={value} value={value}>
                {t(REPEAT_LABEL_KEYS[value])}
              </option>
            ))}
          </select>
        </label>
        {error !== null ? (
          <p className="mobile-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice !== null ? (
          <p className="alert alert-note" role="status">
            {notice}
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void add()}
        >
          {t("mobile.reminders.add")}
        </button>
      </div>
    </>
  );
}
