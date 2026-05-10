/**
 * On-screen debug HUD for verifying SIMID lifecycle + remote-nav + focus
 * behaviour on a CTV WebView. Drop-in: include after simid-protocol.js,
 * before app.js. Activates automatically when the URL contains ?debug=1
 * or when SIMID AdParameters JSON contains { "debug": true }.
 *
 * It logs:
 *   - SIMID Player:* messages received (init, startCreative, etc.)
 *   - Creative:* messages we send + their resolve/reject from the player
 *   - Every keydown event (key, code, keyCode, target tag/id)
 *   - Every focus change (focusin)
 *   - Errors / fatal events
 *
 * The HUD is non-interactive (pointer-events: none) so it cannot steal focus.
 */
(function (global) {
  'use strict';

  // HUD is on by default. Disable with ?debug=0 once you've verified the
  // pipeline end-to-end and you want the iframe overlay to be production-clean.
  // ?debug=verbose adds keydown + focus auto-logging on top — too noisy for
  // protocol-level diagnostics so it's opt-in.
  const params = new URLSearchParams(location.search);
  const forced  = params.get('debug') !== '0';
  const verbose = params.get('debug') === 'verbose';

  const hudEl   = document.getElementById('hud');
  const bodyEl  = document.getElementById('hud-body');
  const metaEl  = document.getElementById('hud-meta');

  if (!hudEl || !bodyEl) return;

  const MAX_ROWS = 30;
  const log = [];
  let bootTime = Date.now();

  function nowTs() {
    const ms = Date.now() - bootTime;
    return (ms / 1000).toFixed(2).padStart(7, ' ') + 's';
  }

  function add(level, text) {
    log.push({ ts: nowTs(), level, text });
    if (log.length > MAX_ROWS) log.shift();
    render();
  }

  function render() {
    bodyEl.innerHTML = log
      .map(r => `<div class="hud-row lc-${r.level}"><span class="ts">${r.ts}</span>${escape(r.text)}</div>`)
      .join('');
  }

  function escape(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
  }

  function setMeta(s) { if (metaEl) metaEl.textContent = s; }

  function show() { hudEl.classList.add('visible'); }

  global.HUD = {
    show, add,
    info:  (m) => add('info',  m),
    key:   (m) => add('key',   m),
    focus: (m) => add('focus', m),
    msg:   (m) => add('msg',   m),
    err:   (m) => add('err',   m),
    setMeta,
    isEnabled: () => forced,
  };

  if (forced) {
    show();
    setMeta('debug=1 · waiting for player');
    add('info', 'HUD active. Window: ' + window.innerWidth + 'x' + window.innerHeight);
    add('info', 'UA: ' + (navigator.userAgent || '').slice(0, 80));
  }

  // Verbose-only: keydown + focusin auto-logs. Off by default so the HUD
  // is readable for protocol-level diagnostics.
  if (verbose) {
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const tgt = t && t.tagName
        ? `${t.tagName.toLowerCase()}${t.id ? '#'+t.id : ''}${t.dataset && t.dataset.id ? '['+t.dataset.id+']' : ''}`
        : '?';
      add('key', `keydown key=${JSON.stringify(e.key)} code=${e.code||'-'} kc=${e.keyCode} → ${tgt}`);
    }, true);

    document.addEventListener('focusin', (e) => {
      const t = e.target;
      const tgt = t && t.tagName
        ? `${t.tagName.toLowerCase()}${t.id ? '#'+t.id : ''}${t.dataset && t.dataset.id ? '['+t.dataset.id+']' : ''}`
        : '?';
      add('focus', `focusin → ${tgt}`);
    });
  }

  window.addEventListener('error', (e) => {
    add('err', `JS error: ${e.message} @ ${e.filename}:${e.lineno}`);
  });

  // Outbound logging is wired up by simid-protocol.js, which calls
  // HUD.logOutbound(envelope) right before postMessage. We avoid patching
  // window.parent.postMessage because cross-origin sandboxed iframes
  // can't reassign properties on the parent window — that throws
  // SecurityError and aborts the rest of this IIFE.
  global.HUD.logOutbound = function (envelope) {
    if (!forced || !envelope) return;
    add('msg', `→ ${envelope.type} #${envelope.messageId}` +
        (envelope.args && Object.keys(envelope.args).length ? ' ' + summarize(envelope.args) : ''));
  };

  window.addEventListener('message', (event) => {
    if (!forced) return;
    let envelope = event.data;
    if (typeof envelope === 'string') {
      try { envelope = JSON.parse(envelope); } catch { return; }
    }
    if (envelope && typeof envelope.type === 'string' &&
        (envelope.type.indexOf('SIMID:') === 0 || envelope.type === 'resolve' || envelope.type === 'reject' || envelope.type === 'createSession')) {
      add('msg', `← ${envelope.type} #${envelope.messageId}` + (envelope.args && Object.keys(envelope.args).length ? ' ' + summarize(envelope.args) : ''));
      if (envelope.type === 'Player:init')           setMeta('init received');
      if (envelope.type === 'Player:startCreative')  setMeta('startCreative — active');
      if (envelope.type === 'Player:adStopped')      setMeta('adStopped');
    }
  }, true);

  function summarize(obj) {
    try {
      const s = JSON.stringify(obj);
      return s.length > 90 ? s.slice(0, 87) + '…' : s;
    } catch { return ''; }
  }
})(window);
