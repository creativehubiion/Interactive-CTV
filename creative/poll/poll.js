/**
 * Interactive CTV ad — 5-option poll with D-pad navigation, inside a SIMID
 * iframe. Layout: transparent left half (linear video bleeds through),
 * opaque poll panel on the right.
 *
 * Includes a debug HUD (top-left) that auto-fires Creative:requestPause +
 * Creative:requestChangeVolume on startCreative AND exposes manual
 * triggers via remote keys 1/2/3 — so we can verify whether IMA
 * Android 3.30.3 honours them and (per KB §17) capture the resolve /
 * reject reply.
 */
(function () {
  'use strict';

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
  const navList = opts;

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
    log('▶ poll active · auto-firing pause / mute / resize probes…');
    tracker.event('simid_start');
    showStage();
    armInactivity();
    armHardCap();
    simid.reportTracking('creativeView').catch(() => {});
    tracker.event('poll_view');
    requestAnimationFrame(() => focusRow(0));

    // Auto-fire the three SIMID requests we want to diagnose. Each promise
    // will resolve (player accepted) or reject (player refused) and the
    // result lands in the HUD.
    setTimeout(() => probe('Creative:requestPause',         simid.requestPause()),                500);
    setTimeout(() => probe('Creative:requestChangeVolume',  simid.changeVolume(0, true)),         900);
    setTimeout(() => probe('Creative:requestResize · left', simid.send('SIMID:Creative:requestResize', {
      videoDimensions:    { x: 0, y: 0, width: 1056, height: 1080 },  // 55% of 1920
      creativeDimensions: { x: 0, y: 0, width: 1920, height: 1080 },
    })), 1300);
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
  let focusedIdx = 0;

  function focusRow(idx) {
    if (idx < 0) idx = 0;
    if (idx >= navList.length) idx = navList.length - 1;
    focusedIdx = idx;
    navList.forEach((el, i) => el.classList.toggle('focused', i === idx));
    try { navList[idx].focus(); } catch (_) {}
  }

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

    if (matchKey(e, KEY.UP))   { focusRow(focusedIdx - 1); e.preventDefault(); return; }
    if (matchKey(e, KEY.DOWN)) { focusRow(focusedIdx + 1); e.preventDefault(); return; }

    // Manual SIMID-request probes — fire from the remote / keyboard so we
    // can re-test pause/mute at any point during the ad.
    if (matchKey(e, KEY.NUM_1)) {
      probe('Creative:requestPause [manual]', simid.requestPause());
      e.preventDefault(); return;
    }
    if (matchKey(e, KEY.NUM_2)) {
      probe('Creative:requestChangeVolume [manual]', simid.changeVolume(0, true));
      e.preventDefault(); return;
    }
    if (matchKey(e, KEY.NUM_3)) {
      probe('Creative:requestResize [manual]', simid.send('SIMID:Creative:requestResize', {
        videoDimensions:    { x: 0, y: 0, width: 1056, height: 1080 },
        creativeDimensions: { x: 0, y: 0, width: 1920, height: 1080 },
      }));
      e.preventDefault(); return;
    }

    if (matchKey(e, KEY.OK)) {
      selectAndSubmit(navList[focusedIdx]);
      e.preventDefault();
      return;
    }
  });

  // Click fallback (desktop testing — Fire TV remote uses 1/2/3 keys).
  opts.forEach(o => o.addEventListener('click', () => selectAndSubmit(o)));
  document.getElementById('btn-pause') ?.addEventListener('click', () =>
    probe('Creative:requestPause [btn]', simid.requestPause()));
  document.getElementById('btn-mute')  ?.addEventListener('click', () =>
    probe('Creative:requestChangeVolume [btn]', simid.changeVolume(0, true)));
  document.getElementById('btn-resize')?.addEventListener('click', () =>
    probe('Creative:requestResize [btn]', simid.send('SIMID:Creative:requestResize', {
      videoDimensions:    { x: 0, y: 0, width: 1056, height: 1080 },
      creativeDimensions: { x: 0, y: 0, width: 1920, height: 1080 },
    })));

  // Kick off the SIMID handshake.
  simid.createSession();
  simid.ready().catch(() => {});
})();
