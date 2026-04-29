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
  const params = new URLSearchParams(location.search);
  const forced = params.get('debug') !== '0';

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

  // Universal keydown logger — lets us see exactly what the WebView delivers
  // for each remote button. Captures even if other handlers preventDefault.
  document.addEventListener('keydown', (e) => {
    if (!forced) return;
    const t = e.target;
    const tgt = t && t.tagName
      ? `${t.tagName.toLowerCase()}${t.id ? '#'+t.id : ''}${t.dataset && t.dataset.id ? '['+t.dataset.id+']' : ''}`
      : '?';
    add('key', `keydown key=${JSON.stringify(e.key)} code=${e.code||'-'} kc=${e.keyCode} → ${tgt}`);
  }, true);

  document.addEventListener('focusin', (e) => {
    if (!forced) return;
    const t = e.target;
    const tgt = t && t.tagName
      ? `${t.tagName.toLowerCase()}${t.id ? '#'+t.id : ''}${t.dataset && t.dataset.id ? '['+t.dataset.id+']' : ''}`
      : '?';
    add('focus', `focusin → ${tgt}`);
  });

  window.addEventListener('error', (e) => {
    add('err', `JS error: ${e.message} @ ${e.filename}:${e.lineno}`);
  });

  // Patch postMessage so we can see exactly what the creative sends out
  // and what the player sends back. This is what tells us whether the IMA
  // host is even speaking SIMID.
  const origPostMessage = window.parent.postMessage.bind(window.parent);
  window.parent.postMessage = function (data, target) {
    if (forced) {
      try {
        const obj = typeof data === 'string' ? JSON.parse(data) : data;
        if (obj && obj.protocol === 'SIMID') {
          add('msg', `→ ${obj.type} #${obj.messageId}` + (obj.args && Object.keys(obj.args).length ? ' ' + summarize(obj.args) : ''));
        }
      } catch { /* not JSON */ }
    }
    return origPostMessage(data, target);
  };

  window.addEventListener('message', (event) => {
    if (!forced) return;
    let envelope = event.data;
    if (typeof envelope === 'string') {
      try { envelope = JSON.parse(envelope); } catch { return; }
    }
    if (envelope && envelope.protocol === 'SIMID') {
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
