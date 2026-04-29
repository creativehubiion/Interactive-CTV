/**
 * iion DMP tracker integration. Fires fire-and-forget GET pings to the DMP
 * for every meaningful SIMID + gameplay event so we get full engagement
 * funnel data per impression in the DMP.
 *
 * Usage:
 *   const tracker = new Tracker({
 *     baseUrl: '<tracker URL with pre-filled macros, ending in event_name= or no trailing event>',
 *     context: { creative_id: 'fruit-catch-v1', ... },
 *   });
 *   tracker.event('simid_init');
 *   tracker.event('fruit_catch', { item: '🍎' });
 *
 * The base URL can be supplied either via:
 *   1. constructor opts.baseUrl
 *   2. SIMID creativeData.adParameters JSON: { "tracker_url": "..." }
 *      (parsed by simid-protocol.js' parseAdParameters())
 *   3. URL query parameter ?tracker= on the creative URL
 *   4. Built-in default (staging endpoint, fine for testing)
 *
 * Transport: uses `new Image().src = url` — works inside cross-origin
 * sandboxed iframes (which is what SIMID creatives are), bypasses CORS,
 * fire-and-forget, no buffering issues. Falls through to navigator.sendBeacon
 * when available for reliability on page-unload.
 */
(function (global) {
  'use strict';

  // Default base URL. Replace with production when ready, or override per
  // campaign via AdParameters.tracker_url in the VAST tag.
  const DEFAULT_BASE_URL =
    'https://staging-dmp-producer.iion.io/tracker/impressions';

  class Tracker {
    constructor(opts = {}) {
      this.baseUrl  = opts.baseUrl || DEFAULT_BASE_URL;
      this.context  = Object.assign({}, opts.context || {});
      this.enabled  = opts.enabled !== false;
      this.firedEvents = [];
    }

    /** Merge context fields that get included on every event. */
    setContext(ctx) {
      Object.assign(this.context, ctx || {});
    }

    /**
     * Fire an event. `name` is short snake_case; `params` is event-specific
     * data that gets merged with the running context. The event is always
     * recorded locally in firedEvents[] regardless of enabled state, so
     * the HUD can display it.
     */
    event(name, params) {
      params = params || {};
      const ts = Date.now();
      const record = { ts, name, params };
      this.firedEvents.push(record);
      if (this.firedEvents.length > 200) this.firedEvents.shift();
      if (window.HUD && typeof window.HUD.info === 'function') {
        const summary = Object.keys(params).length
          ? ' ' + JSON.stringify(params).slice(0, 80)
          : '';
        window.HUD.info('📡 ' + name + summary);
      }
      if (!this.enabled) return;
      const url = this._buildUrl(name, params);
      this._fire(url);
    }

    _buildUrl(eventName, params) {
      const merged = Object.assign({}, this.context, params, { event_name: eventName });
      // If the base URL already has a query string with macros (typical for
      // the iion tracker template), append our params with &.  Otherwise
      // start a fresh querystring with ?.
      const sep = this.baseUrl.indexOf('?') === -1 ? '?' : '&';
      const qs = Object.keys(merged)
        .filter(k => merged[k] !== undefined && merged[k] !== null)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(merged[k])))
        .join('&');
      // Preserve any unfilled macros (%%xxx%%) — those are placeholders that
      // the SSP would normally fill server-side; if they reach us literally
      // it just means a direct creative test.
      return this.baseUrl + sep + qs;
    }

    _fire(url) {
      // Image-pixel transport — most universal across CTV WebViews.
      try {
        const img = new Image(1, 1);
        img.referrerPolicy = 'no-referrer-when-downgrade';
        img.onload  = function () { /* delivered */ };
        img.onerror = function () { /* swallow — fire-and-forget */ };
        img.src = url;
        return;
      } catch (_) { /* fall through */ }
      // Fallback: sendBeacon (only in browsers, ignored on most CTV WebViews
      // but harmless).
      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          navigator.sendBeacon(url);
        }
      } catch (_) { /* swallow */ }
    }

    /** Convenience constructor that pulls overrides from URL + AdParameters. */
    static fromEnvironment(adParametersObj) {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get('tracker');
      const fromAd    = adParametersObj && adParametersObj.tracker_url;
      const baseUrl   = fromAd || fromQuery || undefined;
      const context = {};
      if (adParametersObj) {
        // Pass through any campaign-specific context the seller put in
        // AdParameters: campaign_id, line_item, creative_id, etc.
        for (const k of Object.keys(adParametersObj)) {
          if (k === 'tracker_url') continue;
          context[k] = adParametersObj[k];
        }
      }
      return new Tracker({ baseUrl, context });
    }
  }

  global.Tracker = Tracker;
})(window);
