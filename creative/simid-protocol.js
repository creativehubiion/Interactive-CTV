/**
 * Minimal SIMID 1.1 creative-side protocol.
 * Implements the postMessage transport described in the IAB SIMID spec
 * (interactiveadvertisingbureau.github.io/SIMID/) and the canonical
 * examples/simid_protocol.js reference, scoped to what an interactive CTV
 * creative actually needs.
 *
 * Lifecycle: Player:init -> resolve -> Player:startCreative -> creative active.
 * Stop / skip / fatal: Creative:requestStop / requestSkip / fatalError.
 */
(function (global) {
  'use strict';

  // Google's reference creative (sample_simid_compiled.html) omits the
  // protocol field entirely — its envelope is just {type,sessionId,messageId,
  // timestamp,args}. IMA sends the same shape. Filtering inbound messages on
  // a `protocol` field that IMA never sets caused us to silently drop every
  // Player:* message, including init — which is why our overlay never showed
  // even though the linear played.
  // Filter by message TYPE instead.
  const isSimidEnvelope = (envelope) => {
    if (!envelope || typeof envelope.type !== 'string') return false;
    const t = envelope.type;
    return t.indexOf('SIMID:') === 0 || t === 'resolve' || t === 'reject' || t === 'createSession';
  };

  // Message types in the SIMID 1.1 wire format are namespace-prefixed with
  // "SIMID:" — i.e. "SIMID:Player:init", not bare "Player:init". Google's
  // working sample creative uses these exact strings; IMA sends and listens
  // for these. Our previous version dropped the prefix and silently lost
  // every message, which is why the iframe was kept hidden by IMA.
  const PlayerMessage = {
    INIT:                 'SIMID:Player:init',
    START_CREATIVE:       'SIMID:Player:startCreative',
    AD_SKIPPED:           'SIMID:Player:adSkipped',
    AD_STOPPED:           'SIMID:Player:adStopped',
    FATAL_ERROR:          'SIMID:Player:fatalError',
    RESIZE:               'SIMID:Player:resize',
    APP_BACKGROUNDED:     'SIMID:Player:appBackgrounded',
    APP_FOREGROUNDED:     'SIMID:Player:appForegrounded',
  };

  const CreativeMessage = {
    READY:                'SIMID:Creative:ready',
    CLICK_THRU:           'SIMID:Creative:clickThru',
    REQUEST_PLAY:         'SIMID:Creative:requestPlay',
    REQUEST_PAUSE:        'SIMID:Creative:requestPause',
    REQUEST_STOP:         'SIMID:Creative:requestStop',
    REQUEST_SKIP:         'SIMID:Creative:requestSkip',
    REQUEST_FULL_SCREEN:  'SIMID:Creative:requestFullScreen',
    REPORT_TRACKING:      'SIMID:Creative:reportTracking',
    FATAL_ERROR:          'SIMID:Creative:fatalError',
    LOG:                  'SIMID:Creative:log',
    GET_MEDIA_STATE:      'SIMID:Creative:getMediaState',
  };

  const MediaMessage = {
    DURATION_CHANGE: 'SIMID:Media:durationchange',
    ENDED:           'SIMID:Media:ended',
    ERROR:           'SIMID:Media:error',
    PAUSE:           'SIMID:Media:pause',
    PLAY:            'SIMID:Media:play',
    PLAYING:         'SIMID:Media:playing',
    SEEKED:          'SIMID:Media:seeked',
    SEEKING:         'SIMID:Media:seeking',
    STALLED:         'SIMID:Media:stalled',
    TIMEUPDATE:      'SIMID:Media:timeupdate',
    VOLUME_CHANGE:   'SIMID:Media:volumechange',
  };

  class SimidCreative {
    constructor() {
      this._sessionId      = '';
      this._nextMessageId  = 1;
      this._listeners      = new Map();   // messageType -> [handler]
      this._pendingResolves = new Map();  // messageId    -> {resolve, reject}
      this._environmentData = null;       // from Player:init
      this._creativeData    = null;       // from Player:init (incl. AdParameters)

      const onMsg = this._onMessage.bind(this);
      window.addEventListener('message', onMsg);

      // Drain any messages that arrived before this script loaded.
      // The early-bird inline script in <head> captures every postMessage
      // into __simidEarlyBuffer; replay them here through our normal handler
      // so listeners see them in order.
      if (Array.isArray(global.__simidEarlyBuffer)) {
        const buf = global.__simidEarlyBuffer.splice(0, global.__simidEarlyBuffer.length);
        for (const ev of buf) onMsg(ev);
      }
      if (typeof global.__simidEarlyHandler === 'function') {
        window.removeEventListener('message', global.__simidEarlyHandler, true);
        global.__simidEarlyHandler = null;
      }

      // Auto-handle Player:init -> resolve.
      this.on(PlayerMessage.INIT, (data, msg) => {
        this._sessionId       = msg.sessionId || this._sessionId;
        this._environmentData = data?.environmentData || null;
        this._creativeData    = data?.creativeData    || null;
        this._reply(msg, /* success */ true, {
          moduleName: 'interactive-ctv-ref',
          moduleVersion: '0.1.0',
        });
        this._fire('init', this._environmentData, this._creativeData);
      });

      this.on(PlayerMessage.START_CREATIVE, (_data, msg) => {
        this._reply(msg, true, {});
        this._fire('start');
      });

      this.on(PlayerMessage.AD_STOPPED, () => this._fire('stopped'));
      this.on(PlayerMessage.AD_SKIPPED, () => this._fire('skipped'));
      this.on(PlayerMessage.FATAL_ERROR, () => this._fire('fatalError'));
      this.on(PlayerMessage.RESIZE,      (d) => this._fire('resize', d));

      this._eventHandlers = new Map();
    }

    /* ---- public API ----------------------------------------------------- */

    /** Register a handler for a Player/Media message type. */
    on(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(handler);
    }

    /** Emit a creative -> player message. Returns a Promise resolved on player ack. */
    send(type, args = {}) {
      const messageId = this._nextMessageId++;
      // Envelope shape mirrors Google's reference creative exactly:
      // {type, sessionId, messageId, timestamp, args} — no protocol field.
      const envelope = {
        type,
        sessionId: this._sessionId,
        messageId,
        timestamp: Date.now(),
        args,
      };
      return new Promise((resolve, reject) => {
        this._pendingResolves.set(messageId, { resolve, reject });
        try {
          if (window.HUD && typeof window.HUD.logOutbound === 'function') {
            window.HUD.logOutbound(envelope);
          }
          window.parent.postMessage(JSON.stringify(envelope), '*');
        } catch (e) {
          this._pendingResolves.delete(messageId);
          reject(e);
        }
      });
    }

    /** Tell the player the creative is ready (separate from the init reply). */
    ready() { return this.send(CreativeMessage.READY); }

    /**
     * Initiate the SIMID session. Per Google's reference creative this is the
     * first message the creative sends — it generates a UUID sessionId and
     * emits `createSession`. The player responds with `Player:init`. Without
     * this, some players never start the handshake.
     */
    createSession() {
      this._sessionId = generateUuid();
      // createSession is sent without the SIMID: prefix and without our
      // sessionId-tracked Promise machinery, matching the reference impl.
      const envelope = {
        type: 'createSession',
        sessionId: this._sessionId,
        messageId: this._nextMessageId++,
        timestamp: Date.now(),
        args: {},
      };
      try {
        if (window.HUD && typeof window.HUD.logOutbound === 'function') {
          window.HUD.logOutbound(envelope);
        }
        window.parent.postMessage(JSON.stringify(envelope), '*');
      } catch (e) { /* parent gone */ }
    }

    requestStop(reason)   { return this.send(CreativeMessage.REQUEST_STOP,  { reason }); }
    requestSkip()         { return this.send(CreativeMessage.REQUEST_SKIP); }
    requestPlay()         { return this.send(CreativeMessage.REQUEST_PLAY); }
    requestPause()        { return this.send(CreativeMessage.REQUEST_PAUSE); }
    clickThru(url)        { return this.send(CreativeMessage.CLICK_THRU,    { url }); }
    fatalError(reason)    { return this.send(CreativeMessage.FATAL_ERROR,   { reason }); }
    log(msg)              { return this.send(CreativeMessage.LOG,           { message: msg }); }

    /** Fire a tracking macro defined in the VAST tag. */
    reportTracking(eventName, params)  {
      return this.send(CreativeMessage.REPORT_TRACKING, { eventName, params });
    }

    /** Subscribe to lifecycle events emitted by this wrapper. */
    addEventListener(name, fn) {
      if (!this._eventHandlers.has(name)) this._eventHandlers.set(name, []);
      this._eventHandlers.get(name).push(fn);
    }

    get environmentData() { return this._environmentData; }
    get creativeData()    { return this._creativeData; }

    /** Convenience: parse <AdParameters> JSON if the seller passed one in. */
    parseAdParameters() {
      const raw = this._creativeData?.adParameters;
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    }

    /* ---- internal ------------------------------------------------------- */

    _fire(name, ...args) {
      const handlers = this._eventHandlers.get(name) || [];
      handlers.forEach(h => { try { h(...args); } catch (e) { console.error(e); } });
    }

    _onMessage(event) {
      let envelope = event.data;
      if (typeof envelope === 'string') {
        try { envelope = JSON.parse(envelope); } catch { return; }
      }
      if (!isSimidEnvelope(envelope)) return;

      const { type, messageId, args } = envelope;

      // Resolve/reject of an outgoing creative message.
      if (type === 'resolve' || type === 'reject') {
        const pending = this._pendingResolves.get(args?.messageId);
        if (pending) {
          this._pendingResolves.delete(args.messageId);
          (type === 'resolve' ? pending.resolve : pending.reject)(args.value);
        }
        return;
      }

      // Dispatch incoming Player:* / Media:* messages to listeners.
      const handlers = this._listeners.get(type) || [];
      handlers.forEach(h => { try { h(args, envelope); } catch (e) { console.error(e); } });
    }

    _reply(originalMsg, success, value) {
      const replyEnvelope = {
        type: success ? 'resolve' : 'reject',
        sessionId: this._sessionId,
        messageId: this._nextMessageId++,
        timestamp: Date.now(),
        args: { messageId: originalMsg.messageId, value },
      };
      try {
        if (window.HUD && typeof window.HUD.logOutbound === 'function') {
          window.HUD.logOutbound(replyEnvelope);
        }
        window.parent.postMessage(JSON.stringify(replyEnvelope), '*');
      } catch (e) { /* parent gone */ }
    }
  }

  function generateUuid() {
    // Mirrors Google's reference: 36 chars, version-4 UUID-like.
    const HEX = '0123456789abcdef';
    const out = new Array(36);
    let r = 0;
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { out[i] = '-'; continue; }
      if (i === 14) { out[i] = '4'; continue; }
      if (r <= 2) r = (Math.random() * 0x100000000) | 0;
      const d = r & 0xf;
      r >>= 4;
      out[i] = HEX[i === 19 ? (d & 0x3) | 0x8 : d];
    }
    return out.join('');
  }

  global.SimidCreative   = SimidCreative;
  global.SimidMessages   = { Player: PlayerMessage, Creative: CreativeMessage, Media: MediaMessage };
})(window);
