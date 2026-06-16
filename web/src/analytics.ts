import posthog from "posthog-js";

type AnalyticsUser = {
  id: string;
  email?: string;
  name?: string;
};

const POSTHOG_ENABLED = Boolean(import.meta.env.VITE_POSTHOG_KEY);

let identifiedUserId: string | null = null;

export function initAnalytics() {
  if (!POSTHOG_ENABLED) return;
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host: import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    capture_performance: true,
    disable_session_recording: false,
    person_profiles: "identified_only",
    persistence: "localStorage+cookie",
  });
}

export function syncAnalyticsUser(user: AnalyticsUser | null) {
  if (!POSTHOG_ENABLED) return;

  if (user?.id) {
    if (identifiedUserId !== user.id) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
      });
      identifiedUserId = user.id;
    }
    return;
  }

  if (identifiedUserId) {
    // After sign out, switch back to a fresh anonymous distinct_id.
    posthog.reset();
    identifiedUserId = null;
  }
}
