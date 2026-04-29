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

  // The IAB reference implementation tags outgoing messages with
  // `protocol: "SIMID:1.1"`. Some players send bare `"SIMID"`. Accept either
  // — match anything that starts with "SIMID".
  const PROTOCOL_OUT = 'SIMID:1.1';
  const isSimidEnvelope = (envelope) =>
    envelope && typeof envelope.protocol === 'string' && envelope.protocol.indexOf('SIMID') === 0;

  const PlayerMessage = {
    INIT:                 'Player:init',
    START_CREATIVE:       'Player:startCreative',
    AD_SKIPPED:           'Player:adSkipped',
    AD_STOPPED:           'Player:adStopped',
    FATAL_ERROR:          'Player:fatalError',
    RESIZE:               'Player:resize',
    APP_BACKGROUNDED:     'Player:appBackgrounded',
    APP_FOREGROUNDED:     'Player:appForegrounded',
  };

  const CreativeMessage = {
    READY:                'Creative:ready',
    CLICK_THRU:           'Creative:clickThru',
    REQUEST_PLAY:         'Creative:requestPlay',
    REQUEST_PAUSE:        'Creative:requestPause',
    REQUEST_STOP:         'Creative:requestStop',
    REQUEST_SKIP:         'Creative:requestSkip',
    REQUEST_FULL_SCREEN:  'Creative:requestFullScreen',
    REPORT_TRACKING:      'Creative:reportTracking',
    FATAL_ERROR:          'Creative:fatalError',
    LOG:                  'Creative:log',
  };

  const MediaMessage = {
    DURATION_CHANGE: 'Media:durationchange',
    ENDED:           'Media:ended',
    ERROR:           'Media:error',
    PAUSE:           'Media:pause',
    PLAY:            'Media:play',
    PLAYING:         'Media:playing',
    SEEKED:          'Media:seeked',
    SEEKING:         'Media:seeking',
    STALLED:         'Media:stalled',
    TIMEUPDATE:      'Media:timeupdate',
    VOLUME_CHANGE:   'Media:volumechange',
  };

  class SimidCreative {
    constructor() {
      this._sessionId      = '';
      this._nextMessageId  = 1;
      this._listeners      = new Map();   // messageType -> [handler]
      this._pendingResolves = new Map();  // messageId    -> {resolve, reject}
      this._environmentData = null;       // from Player:init
      this._creativeData    = null;       // from Player:init (incl. AdParameters)

      window.addEventListener('message', this._onMessage.bind(this));

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
      const envelope = {
        protocol: PROTOCOL_OUT,
        sessionId: this._sessionId,
        messageId,
        type,
        timestamp: Date.now(),
        args,
      };
      return new Promise((resolve, reject) => {
        this._pendingResolves.set(messageId, { resolve, reject });
        try {
          window.parent.postMessage(JSON.stringify(envelope), '*');
        } catch (e) {
          this._pendingResolves.delete(messageId);
          reject(e);
        }
      });
    }

    /** Tell the player the creative is ready (separate from the init reply). */
    ready() { return this.send(CreativeMessage.READY); }

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
        protocol: PROTOCOL_OUT,
        sessionId: this._sessionId,
        messageId: this._nextMessageId++,
        type: success ? 'resolve' : 'reject',
        timestamp: Date.now(),
        args: { messageId: originalMsg.messageId, value },
      };
      try {
        window.parent.postMessage(JSON.stringify(replyEnvelope), '*');
      } catch (e) { /* parent gone */ }
    }
  }

  global.SimidCreative   = SimidCreative;
  global.SimidMessages   = { Player: PlayerMessage, Creative: CreativeMessage, Media: MediaMessage };
  global.SimidProtocolOut = PROTOCOL_OUT;
})(window);
