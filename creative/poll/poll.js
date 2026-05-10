/**
 * Interactive CTV ad — 5-option poll with D-pad navigation, inside a SIMID
 * iframe. Layout: transparent left half (linear video bleeds through),
 * opaque poll panel on the right.
 *
 * Production: auto-fires Creative:requestPause on startCreative as a
 * best-effort UX improvement (honoured on most browser players, silently
 * dropped on IMA Android 3.30.3 — see KB §17).
 *
 * Append ?debug=1 to the iframe URL to enable the debug HUD, manual
 * pause/mute/resize probes (remote keys 1/2/3 + LEFT/RIGHT pane switch),
 * and verbose protocol logging.
 */
(function () {
  'use strict';

  const isDebug = new URLSearchParams(location.search).get('debug') === '1' ||
                  new URLSearchParams(location.search).get('debug') === 'verbose';

  const KEY = {
    LEFT:  ['ArrowLeft',  37],
    RIGHT: ['ArrowRight', 39],
    UP:    ['ArrowUp',    38],
    DOWN:  ['ArrowDown',  40],
    OK:    ['Enter',      13],
    BACK:  ['Escape', 27, 'Backspace', 8, 'GoBack', 4, 166, 212],
    NUM_1: ['1', 49],
    NUM_2: ['2', 50],
    NUM_3: ['3', 51],
  };

  const matchKey = (e, list) =>
    list.some(k => e.key === k || e.keyCode === k || e.which === k);

  const log = (m) => { if (window.HUD) HUD.info(m); console.log('[ctv-poll]', m); };
  const logErr = (m) => { if (window.HUD) HUD.err(m); console.error('[ctv-poll]', m); };

  // Wraps a SIMID request promise to surface the player's verdict in plain
  // English. hud.js already logs the wire-level → / ← transactions; this
  // wrapper just adds a single ✅ / ❌ summary line + a 2 s timeout that
  // catches "silently dropped" requests (where IMA neither resolves nor
  // rejects) — see KB §17 for why this matters on IMA Android 3.30.3.
  function probe(label, p) {
    let settled = false;
    p.then(reply => {
      settled = true;
      log(`✅ ${label} ACCEPTED`);
    }).catch(err => {
      settled = true;
      logErr(`❌ ${label} REJECTED · ${err && err.message ? err.message : JSON.stringify(err || {}).slice(0,100)}`);
    });
    setTimeout(() => {
      if (!settled) logErr(`⏱  ${label} NO REPLY (silently dropped by player)`);
    }, 2000);
    return p;
  }

  const INACTIVITY_MS = 60_000;
  const HARD_CAP_MS   = 180_000;

  const simid = new SimidCreative();
  let tracker = new Tracker();
  let started   = false;
  let dismissed = false;
  let inactivityTimer = null;
  let hardCapTimer    = null;
  let selectedValue = null;

  // -------- DOM ------------------------------------------------------------
  const stage      = document.getElementById('stage');
  const thanks     = document.getElementById('thanks');
  const thanksTitle= document.getElementById('thanks-title');
  const thanksBody = document.getElementById('thanks-body');

  // 5 poll options form the navigable column. Pressing OK on one
  // is the vote — there is no separate submit button.
  const opts    = Array.from(document.querySelectorAll('.opt'));

  // HUD action buttons form a SECOND navigable column on the left.
  // Pressing LEFT from the poll moves focus to this list; pressing
  // RIGHT from a HUD button moves focus back to the poll.
  const hudBtns = Array.from(document.querySelectorAll('.hud-btn'));
  const hudActions = [
    () => probe('Creative:requestPause [btn]',         simid.requestPause()),
    () => probe('Creative:requestChangeVolume [btn]',  simid.changeVolume(0, true)),
    () => probe('Creative:requestResize [btn]',        simid.send('SIMID:Creative:requestResize', {
      videoDimensions:    { x: 0, y: 0, width: 1056, height: 1080 },
      creativeDimensions: { x: 0, y: 0, width: 1920, height: 1080 },
      viewMode: 'normal',
    })),
  ];

  // Focus state: which pane is active and which row inside it.
  let pane = 'poll';                 // 'poll' | 'hud'
  let pollIdx = 0;
  let hudIdx  = 0;

  // -------- SIMID lifecycle ------------------------------------------------
  simid.addEventListener('init', () => {
    // (hud.js auto-logs the inbound Player:init line — no need to duplicate)
    const adParams = simid.parseAdParameters();
    tracker = Tracker.fromEnvironment(adParams);
    tracker.event('simid_init');
  });
  simid.addEventListener('start',   onStart);
  simid.addEventListener('stopped', () => teardown('player-stopped'));
  simid.addEventListener('skipped', () => teardown('player-skipped'));

  // 2-second auto-start fallback (covers older IMA / custom players).
  setTimeout(() => {
    if (!started) {
      log('No startCreative in 2 s — auto-starting');
      onStart();
    }
  }, 2000);

  function onStart() {
    if (started) return;
    started = true;
    log('▶ poll active');
    tracker.event('simid_start');
    showStage();
    armInactivity();
    armHardCap();
    simid.reportTracking('creativeView').catch(() => {});
    tracker.event('poll_view');
    requestAnimationFrame(() => focusRow(0));

    // Best-effort: ask the player to pause the linear so the user can focus
    // on the poll. Honoured on browser players (IMA HTML5, IAB ref) — linear
    // freezes for the duration of the interaction. Silently no-op on IMA
    // Android (linear keeps playing under the overlay — see KB §17).
    setTimeout(() => simid.requestPause().catch(() => {}), 500);

    // Debug-only: diagnostic probes for requestChangeVolume + requestResize.
    // Both are universally rejected per testing — kept here so a debug run
    // can capture the rejection patterns in the HUD without polluting prod.
    if (isDebug) {
      setTimeout(() => probe('Creative:requestChangeVolume',  simid.changeVolume(0)), 900);
      setTimeout(() => probe('Creative:requestResize · left', simid.send('SIMID:Creative:requestResize', {
        videoDimensions:    { x: 0, y: 0, width: 1056, height: 1080 },  // 55% of 1920
        creativeDimensions: { x: 0, y: 0, width: 1920, height: 1080 },
        viewMode: 'normal',
      })), 1300);
    }
  }

  function showStage() {
    stage.classList.add('visible');
    stage.setAttribute('aria-hidden', 'false');
    window.focus();
  }

  // -------- Exit guardrails ------------------------------------------------
  function armInactivity() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      tracker.event('inactivity_timeout');
      simid.reportTracking('inactivity').catch(() => {});
      log(`Inactivity ${INACTIVITY_MS} ms — auto-skip`);
      teardown('inactivity');
    }, INACTIVITY_MS);
  }
  function armHardCap() {
    clearTimeout(hardCapTimer);
    hardCapTimer = setTimeout(() => {
      tracker.event('hard_cap');
      simid.reportTracking('hardCap').catch(() => {});
      log(`Hard cap ${HARD_CAP_MS} ms — force exit`);
      teardown('hard-cap');
    }, HARD_CAP_MS);
  }
  function pokeInactivity() { armInactivity(); }

  function teardown(reason) {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(inactivityTimer);
    clearTimeout(hardCapTimer);
    stage.classList.remove('visible');
    stage.setAttribute('aria-hidden', 'true');
    log(`Teardown: ${reason}`);
    tracker.event('teardown', { reason });
    simid.requestSkip().catch(() => {});
  }

  // -------- Navigation + selection ----------------------------------------
  function refreshFocus() {
    opts.forEach   ((el, i) => el.classList.toggle('focused', pane === 'poll' && i === pollIdx));
    hudBtns.forEach((el, i) => el.classList.toggle('focused', pane === 'hud'  && i === hudIdx));
    try {
      const el = pane === 'poll' ? opts[pollIdx] : hudBtns[hudIdx];
      if (el) el.focus();
    } catch (_) {}
  }
  function focusRow(idx) { pollIdx = clamp(idx, 0, opts.length - 1);    pane = 'poll'; refreshFocus(); }
  function focusHud(idx) { hudIdx  = clamp(idx, 0, hudBtns.length - 1); pane = 'hud';  refreshFocus(); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function selectAndSubmit(opt) {
    if (selectedValue !== null) return;     // single-vote: ignore further OKs
    const v = parseInt(opt.dataset.value, 10);
    selectedValue = v;
    opts.forEach(o => o.classList.toggle('selected', o === opt));
    log(`Vote: ${v}`);
    tracker.event('poll_vote', { option: v });
    simid.reportTracking('select', { id: 'option-' + v }).catch(() => {});

    thanksTitle.textContent = `Thanks for voting!`;
    thanksBody.textContent  = `You picked option ${v}. Returning you to your show…`;
    thanks.classList.remove('hidden');

    setTimeout(() => teardown('vote-submitted'), 2000);
  }

  // -------- Input ----------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (!started || dismissed) return;
    pokeInactivity();

    if (matchKey(e, KEY.BACK)) {
      tracker.event('back_pressed');
      simid.reportTracking('skip').catch(() => {});
      simid.requestSkip().catch(() => {});
      teardown('user-skip');
      e.preventDefault();
      return;
    }

    // Debug-only: pane-switch (LEFT/RIGHT) + 1/2/3 manual probes.
    if (isDebug) {
      if (matchKey(e, KEY.LEFT))  { focusHud(hudIdx);   e.preventDefault(); return; }
      if (matchKey(e, KEY.RIGHT)) { focusRow(pollIdx);  e.preventDefault(); return; }
      if (matchKey(e, KEY.NUM_1)) { hudActions[0](); e.preventDefault(); return; }
      if (matchKey(e, KEY.NUM_2)) { hudActions[1](); e.preventDefault(); return; }
      if (matchKey(e, KEY.NUM_3)) { hudActions[2](); e.preventDefault(); return; }
    }

    // Up/Down navigates within whichever pane is active (HUD pane only
    // possible in debug mode; in production it's always the poll pane).
    if (matchKey(e, KEY.UP)) {
      pane === 'hud' ? focusHud(hudIdx - 1) : focusRow(pollIdx - 1);
      e.preventDefault(); return;
    }
    if (matchKey(e, KEY.DOWN)) {
      pane === 'hud' ? focusHud(hudIdx + 1) : focusRow(pollIdx + 1);
      e.preventDefault(); return;
    }

    // OK either votes (poll pane) or fires the focused HUD action.
    if (matchKey(e, KEY.OK)) {
      if (pane === 'hud') hudActions[hudIdx]();
      else                selectAndSubmit(opts[pollIdx]);
      e.preventDefault();
      return;
    }
  });

  // Click fallback (desktop testing).
  opts.forEach(o => o.addEventListener('click', () => selectAndSubmit(o)));
  if (isDebug) {
    hudBtns.forEach((el, i) => el.addEventListener('click', () => hudActions[i]()));
  }

  // Kick off the SIMID handshake.
  simid.createSession();
  simid.ready().catch(() => {});
})();
