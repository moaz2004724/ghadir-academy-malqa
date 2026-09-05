// Read-only polling works across browsers, devices and backend replicas.
// Never reload the document or send writes while refreshing server data.
export const LIVE_REFRESH_INTERVAL_MS = 3000;

export function startLiveRefresh({ refresh, canRefresh = () => true, windowTarget = window, documentTarget = document, timers = globalThis, intervalMs = LIVE_REFRESH_INTERVAL_MS }) {
  let stopped = false;
  let running = false;
  let timer;
  let controller;
  let retryMs = intervalMs;
  const allowed = () => !stopped && !documentTarget.hidden && canRefresh();
  const schedule = delay => {
    timers.clearTimeout(timer);
    if (!stopped) timer = timers.setTimeout(run, delay);
  };
  async function run() {
    if (stopped || running) return;
    if (!allowed()) { schedule(intervalMs); return; }
    running = true;
    controller = new AbortController();
    const timeout = timers.setTimeout(() => controller?.abort(), 15000);
    try {
      const result = await refresh({ background: true, signal: controller.signal });
      retryMs = result ? intervalMs : Math.min(retryMs * 2, 30000);
    } catch { retryMs = Math.min(retryMs * 2, 30000); }
    finally {
      timers.clearTimeout(timeout);
      running = false;
      if (!stopped) schedule(retryMs);
    }
  }
  const wake = () => { if (allowed() && !running) schedule(0); };
  windowTarget.addEventListener('focus', wake);
  windowTarget.addEventListener('online', wake);
  documentTarget.addEventListener('visibilitychange', wake);
  // When an input loses focus, refresh after the current click/save handler.
  documentTarget.addEventListener('focusout', wake);
  schedule(intervalMs);
  return () => {
    stopped = true;
    timers.clearTimeout(timer);
    controller?.abort();
    windowTarget.removeEventListener('focus', wake);
    windowTarget.removeEventListener('online', wake);
    documentTarget.removeEventListener('visibilitychange', wake);
    documentTarget.removeEventListener('focusout', wake);
  };
}

export function isEditingPage(doc = document) {
  return !!doc.querySelector('[aria-modal="true"], [data-live-refresh-pause]') ||
    !!doc.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
}

export function keepUnchanged(previous, next) {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export function canApplyRead({ sequence, latestSequence, session, currentSession, generation, currentGeneration, background, blocked, aborted }) {
  return !aborted && sequence === latestSequence && session === currentSession && generation === currentGeneration && (!background || !blocked);
}
