/**
 * Interactive CTV ad — Fruit-catch mini-game inside our SIMID 1.1 shell.
 *
 * Lifecycle:
 *   1. simid-protocol.js handshakes with IMA on load (createSession,
 *      resolves Player:init — which un-hides the iframe — resolves
 *      Player:startCreative).
 *   2. On startCreative we pause the linear (Creative:requestPause), show
 *      the stage, and start the game.
 *   3. User plays. D-pad Left/Right moves the basket, Up moves focus to
 *      the Skip button, OK on Skip ends the round, Back exits immediately.
 *   4. Round ends naturally at 30 s with an end card. We then resume the
 *      linear (Creative:requestPlay) and request stop (Creative:requestStop)
 *      so the ad slot wraps cleanly.
 *
 * Exit guardrails (IAB-recommended; required by most SSP QA gates):
 *   - Visible Skip button (Up arrow brings focus, OK confirms)
 *   - Back/Escape → instant skip
 *   - 60 s of zero remote activity → auto-skip
 *   - 180 s hard cap → force-exit
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

  const log = (m) => { if (window.HUD) HUD.info(m); console.log('[ctv-ad]', m); };

  // Exit guardrails.
  const INACTIVITY_MS = 60_000;
  const HARD_CAP_MS   = 180_000;

  const simid = new SimidCreative();
  let started   = false;
  let dismissed = false;
  let inactivityTimer = null;
  let hardCapTimer    = null;

  // -------- DOM ------------------------------------------------------------
  const stage      = document.getElementById('stage');
  const fieldEl    = document.getElementById('field');
  const playerEl   = document.getElementById('player');
  const scoreEl    = document.getElementById('score');
  const timerEl    = document.getElementById('timer');
  const endcard    = document.getElementById('endcard');
  const endTitle   = document.getElementById('end-title');
  const endScoreEl = document.getElementById('end-score');
  const skipBtn    = document.getElementById('skip');
  const hint       = document.getElementById('hint');

  const game = new FruitCatchGame({
    field: fieldEl,
    player: playerEl,
    scoreEl, timerEl,
    endcard, endTitle, endScoreEl,
  });

  game.events.on('end', (score) => {
    log('Round ended — score=' + score);
    simid.reportTracking('gameComplete', { score }).catch(() => {});
    // Brief pause so the user reads the end card, then tear down.
    setTimeout(() => teardown('game-complete'), 2000);
  });

  // -------- SIMID lifecycle ------------------------------------------------
  simid.addEventListener('init',    () => log('Player:init handled'));
  simid.addEventListener('start',   onStart);
  simid.addEventListener('stopped', () => teardown('player-stopped'));
  simid.addEventListener('skipped', () => teardown('player-skipped'));

  setTimeout(() => {
    if (!started) {
      log('No startCreative in 2 s — falling back to auto-start');
      onStart();
    }
  }, 2000);

  function onStart() {
    if (started) return;
    started = true;
    log('Player:startCreative — pausing linear, muting, starting game');
    // Pause + mute the linear. Pause alone doesn't reliably stop audio
    // on every IMA build; pairing with a 0-volume change is bulletproof.
    simid.requestPause().catch(() => {});
    simid.changeVolume(0, true).catch(() => {});
    showStage();
    armInactivity();
    armHardCap();
    simid.reportTracking('creativeView').catch(() => {});
    // Defer game start one frame so layout/measure is correct.
    requestAnimationFrame(() => game.start());
  }

  // -------- Stage / Focus --------------------------------------------------
  function showStage() {
    stage.classList.add('visible');
    stage.setAttribute('aria-hidden', 'false');
    window.focus();
    // We don't actually focus the body for D-pad — keydown listeners on
    // document handle everything. But focusing prevents focus from being
    // stuck on something else.
  }

  // -------- Exit guardrails ------------------------------------------------
  function armInactivity() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      simid.reportTracking('inactivity').catch(() => {});
      log(`Inactivity ${INACTIVITY_MS} ms — auto-skip`);
      teardown('inactivity');
    }, INACTIVITY_MS);
  }

  function armHardCap() {
    clearTimeout(hardCapTimer);
    hardCapTimer = setTimeout(() => {
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
    game.stop();
    stage.classList.remove('visible');
    stage.setAttribute('aria-hidden', 'true');
    log(`Teardown: ${reason}`);
    // Restore audio so the next ad in the pod isn't muted.
    simid.changeVolume(1, false).catch(() => {});
    simid.requestPlay().catch(() => {});
    simid.requestStop(reason).catch(() => {});
  }

  // -------- Input ----------------------------------------------------------
  function fadeHintOnce() {
    if (hint && !hint.classList.contains('faded')) hint.classList.add('faded');
  }

  document.addEventListener('keydown', (e) => {
    if (!started || dismissed) return;
    pokeInactivity();
    fadeHintOnce();
    // Unlock the audio context on the first remote keypress, in case the
    // browser left it suspended at SIMID start (some Fire TV WebView builds
    // require a user gesture before audio is allowed even with the
    // "media playback doesn't require gesture" flag set).
    if (window.GameSfx) window.GameSfx.unlock();

    if (matchKey(e, KEY.BACK)) {
      simid.reportTracking('skip').catch(() => {});
      simid.requestSkip().catch(() => {});
      teardown('user-skip');
      e.preventDefault();
      return;
    }

    // OK on Skip button → confirm skip.
    if (matchKey(e, KEY.OK) && document.activeElement === skipBtn) {
      simid.reportTracking('skip').catch(() => {});
      teardown('user-skip-button');
      e.preventDefault();
      return;
    }

    // Up arrow grabs focus to Skip from anywhere.
    if (matchKey(e, KEY.UP)) {
      skipBtn.focus();
      e.preventDefault();
      return;
    }

    // Down from Skip returns to game (and clears focus).
    if (matchKey(e, KEY.DOWN) && document.activeElement === skipBtn) {
      skipBtn.blur();
      e.preventDefault();
      return;
    }

    // Game movement — only when Skip isn't focused.
    if (document.activeElement !== skipBtn) {
      if (matchKey(e, KEY.LEFT))  { game.handleKey('left',  true);  e.preventDefault(); return; }
      if (matchKey(e, KEY.RIGHT)) { game.handleKey('right', true);  e.preventDefault(); return; }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (!started || dismissed) return;
    if (matchKey(e, KEY.LEFT))  game.handleKey('left',  false);
    if (matchKey(e, KEY.RIGHT)) game.handleKey('right', false);
  });

  skipBtn.addEventListener('click', () => {
    simid.reportTracking('skip').catch(() => {});
    teardown('user-skip-button');
  });

  // Kick off the SIMID handshake.
  simid.createSession();
  simid.ready().catch(() => {});
})();
