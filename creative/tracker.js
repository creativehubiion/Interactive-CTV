/**
 * iion DMP tracker integration. Fires fire-and-forget GET pings to a tracker
 * URL provided per-impression by the DSP/SSP via VAST AdParameters.
 *
 * **Zero hardcoded campaign/creative identifiers.** Everything that varies
 * per impression (campaign_id, publisher_id, creative_id, IFA, IP, geo, etc.)
 * is filled in by the seller's PLL macros (`%%campaignId%%` style) BEFORE
 * the URL reaches the creative. The creative just appends `event_name=…` and
 * any event-specific runtime data (score, glyph) to that pre-built URL.
 *
 * Configuration sources (checked in order):
 *   1. VAST <AdParameters> JSON: { "tracker_url": "<full URL ending in event_name=>" }
 *      ← the standard production path; the DSP/SSP supplies the URL with
 *        macros already substituted
 *   2. Creative URL query string: ?tracker=<URL-encoded full tracker URL>
 *      ← convenient for ad-hoc tests outside the RTB pipeline
 *   3. None — the tracker is silently disabled (no events fire)
 *
 * Transport: `new Image().src = url` — works inside cross-origin sandboxed
 * SIMID iframes, no CORS preflight, fire-and-forget. No request batching.
 */
(function (global) {
  'use strict';

  class Tracker {
    constructor(opts) {
      opts = opts || {};
      this.baseUrl = opts.baseUrl || '';
      this.enabled = !!this.baseUrl;
      this.firedEvents = [];
    }

    /**
     * Fire one event. `name` is short snake_case (e.g. "simid_init",
     * "fruit_catch"); `params` is event-specific runtime data only —
     * NEVER pass campaign/creative identifiers here, those belong in
     * the URL template via macros.
     */
    event(name, params) {
      params = params || {};
      const record = { ts: Date.now(), name, params };
      this.firedEvents.push(record);
      if (this.firedEvents.length > 200) this.firedEvents.shift();

      // Show on the on-screen HUD regardless of whether a tracker URL is
      // configured — useful for debugging.
      if (window.HUD && typeof window.HUD.info === 'function') {
        const summary = Object.keys(params).length
          ? ' ' + JSON.stringify(params).slice(0, 80)
          : '';
        window.HUD.info('📡 ' + name + summary);
      }

      if (!this.enabled) return;
      this._fire(this._buildUrl(name, params));
    }

    /**
     * Construct the final URL to fire. Preserves the seller's URL exactly
     * as supplied — does not URL-encode unfilled macros, does not rewrite
     * existing query parameters.
     *
     * The standard iion tracker template ends with `&event_name=` (or
     * `?event_name=`). We detect that and just concatenate the event name.
     * Otherwise we add `&event_name=<value>` to the end.
     *
     * Event-specific runtime params (e.g. score, glyph) are appended last.
     */
    _buildUrl(eventName, params) {
      let url = this.baseUrl;
      const trailingEventNameMatch = url.match(/[?&]event_name=$/);
      if (trailingEventNameMatch) {
        url += encodeURIComponent(eventName);
      } else if (/[?&]event_name=/.test(url)) {
        // event_name already has a value — replace it (defensive)
        url = url.replace(/([?&])event_name=[^&]*/, '$1event_name=' + encodeURIComponent(eventName));
      } else {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'event_name=' + encodeURIComponent(eventName);
      }
      // Append any event-specific runtime params.
      for (const k of Object.keys(params)) {
        const v = params[k];
        if (v === undefined || v === null) continue;
        url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(v));
      }
      return url;
    }

    _fire(url) {
      try {
        const img = new Image(1, 1);
        img.referrerPolicy = 'no-referrer-when-downgrade';
        img.src = url;
        return;
      } catch (_) { /* fall through */ }
      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          navigator.sendBeacon(url);
        }
      } catch (_) { /* swallow */ }
    }

    /**
     * Build a Tracker by pulling the URL from (in order):
     *   1. AdParameters.tracker_url  (parsed from SIMID creativeData)
     *   2. ?tracker=<urlencoded> on the creative URL
     *   3. nothing — disabled
     */
    static fromEnvironment(adParametersObj) {
      const fromAd = adParametersObj && adParametersObj.tracker_url;
      let fromQuery = '';
      try {
        const params = new URLSearchParams(window.location.search);
        fromQuery = params.get('tracker') || '';
      } catch (_) {}
      const baseUrl = fromAd || fromQuery || '';
      return new Tracker({ baseUrl });
    }
  }

  global.Tracker = Tracker;
})(window);
