/**
 * Interactive CTV ad — 5-option poll with D-pad navigation, inside a SIMID
 * iframe. Layout: transparent left half (linear video bleeds through),
 * opaque poll panel on the right. The iframe holds NO video element of
 * its own, so the linear's audio plays naturally — single source, no
 * cacophony, and crucially: if the SIMID iframe fails to load, the
 * linear plays normally as a standard video ad (good fallback).
 *
 * We do NOT call Creative:requestPause or Creative:requestChangeVolume —
 * they are not honoured on IMA Android 3.30.3 (see KB §17), and we don't
 * need them: there's no competing in-iframe video to mute.
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
  };

  const matchKey = (e, list) =>
    list.some(k => e.key === k || e.keyCode === k || e.which === k);

  const log = (m) => { if (window.HUD) HUD.info(m); console.log('[ctv-poll]', m); };

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
    log('Player:init handled');
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
    log('startCreative → show poll panel (linear keeps playing with audio)');
    tracker.event('simid_start');
    showStage();
    armInactivity();
    armHardCap();
    simid.reportTracking('creativeView').catch(() => {});
    tracker.event('poll_view');
    requestAnimationFrame(() => focusRow(0));
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

    if (matchKey(e, KEY.OK)) {
      selectAndSubmit(navList[focusedIdx]);
      e.preventDefault();
      return;
    }
  });

  // Click fallback for desktop testing.
  opts.forEach(o => o.addEventListener('click', () => selectAndSubmit(o)));

  // Kick off the SIMID handshake.
  simid.createSession();
  simid.ready().catch(() => {});
})();
