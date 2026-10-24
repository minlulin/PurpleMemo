// Short first-run guide.
//
// Presented once on Today and dismissed for good by writing a single boolean.
// It repeats what the rest of the app actually enforces — PIN recovery limits,
// the separate database key, destructive backup restore, and reminders that
// only run while the app is open and unlocked — so a first-run user cannot
// mistake any of them for a guarantee the app does not make.

import { useEffect, useState } from "react";
import { settingsRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { IconClose } from "./icons.tsx";
import { useT } from "./useTranslation.ts";

export function OnboardingGuide() {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dismissed = await settingsRepo.getOnboardingDismissed();
        if (!cancelled) setVisible(!dismissed);
      } catch {
        // A settings read failure must not put a modal-looking guide in the
        // user's way; the guide simply stays hidden until the next launch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    setError(null);
    try {
      await settingsRepo.setOnboardingDismissed(true);
      setVisible(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDismissing(false);
    }
  };

  if (!visible) return null;

  const sections = [
    ["onboarding.pinTitle", "onboarding.pinBody"],
    ["onboarding.keyTitle", "onboarding.keyBody"],
    ["onboarding.backupTitle", "onboarding.backupBody"],
    ["onboarding.offlineTitle", "onboarding.offlineBody"],
  ] as const;

  return (
    <section
      className="settings-section onboarding-guide"
      aria-labelledby="onboarding-title"
    >
      <div className="dash-card-head">
        <h2 className="settings-heading" id="onboarding-title">
          {t("onboarding.title")}
        </h2>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={t("onboarding.dismiss")}
          title={t("onboarding.dismiss")}
          disabled={dismissing}
          onClick={() => void dismiss()}
        >
          <IconClose className="icon" />
        </button>
      </div>
      <p className="page-subtitle">{t("onboarding.intro")}</p>
      <ul className="onboarding-points">
        {sections.map(([title, body]) => (
          <li key={title}>
            <strong>{t(title)}</strong>
            <span className="muted">{t(body)}</span>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="editor-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={dismissing}
          onClick={() => void dismiss()}
        >
          {dismissing ? t("common.wait") : t("onboarding.dismiss")}
        </button>
      </div>
    </section>
  );
}
