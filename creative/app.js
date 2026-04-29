/**
 * Interactive CTV ad — embeds the Allkinds Phaser game inside an iframe and
 * speaks SIMID 1.1 to the IMA player around it.
 *
 * Lifecycle:
 *   1. Page parses → simid-protocol.js handshakes with IMA (createSession,
 *      resolves Player:init, resolves Player:startCreative).
 *   2. On start: linear video paused via Creative:requestPause, stage shown,
 *      iframe given focus so D-pad keypresses go to the game.
 *   3. User plays. The game handles all in-game input itself (Phaser's own
 *      keydown listener inside the iframe).
 *   4. Exit: any of {Back/Escape from remote, focused Skip button + OK,
 *      INACTIVITY_MS of no input, HARD_CAP_MS hit, game complete signal}
 *      → linear video resumed, Creative:requestStop sent, iframe torn down.
 *
 * Exit guardrails (IAB-recommended; required by most SSP QA):
 *   - Visible Skip control (focused with one D-pad press from anywhere)
 *   - Back/Escape always skips
 *   - INACTIVITY_MS = 60s with no input → auto-skip
 *   - HARD_CAP_MS = 180s absolute max → auto-skip regardless of activity
 *   - Watching for postMessage events from the game iframe — if the game
 *     emits a "complete" event, we resume the linear cleanly
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

  // -------- Lifecycle ------------------------------------------------------
  simid.addEventListener('init',    () => log('Player:init handled'));
  simid.addEventListener('start',   onStart);
  simid.addEventListener('stopped', () => teardown('player-stopped'));
  simid.addEventListener('skipped', () => teardown('player-skipped'));

  // Some hosts never deliver Player:startCreative (older IMA, custom players).
  // 2-second fallback so the game still plays in those environments.
  setTimeout(() => {
    if (!started) {
      log('No startCreative in 2s — falling back to auto-start');
      onStart();
    }
  }, 2000);

  function onStart() {
    if (started) return;
    started = true;
    log('Player:startCreative — pausing linear, showing game');

    // Pause the linear so the game runs as long as needed.
    simid.requestPause().catch(() => {});

    showStage();
    armInactivity();
    armHardCap();
    simid.reportTracking('creativeView').catch(() => {});
  }

  // -------- Stage / Focus --------------------------------------------------
  const stage   = document.getElementById('stage');
  const iframe  = document.getElementById('game');
  const skipBtn = document.getElementById('skip');

  function showStage() {
    stage.classList.add('visible');
    stage.setAttribute('aria-hidden', 'false');
    window.focus();
    // Focus the iframe so the game's keydown listener gets D-pad presses.
    // On Fire TV WebView, iframe.contentWindow.focus() is allowed across
    // origin in this context (we're already inside an iframe ourselves;
    // the WebView treats the focus call as user-initiated).
    setTimeout(() => {
      try { iframe.contentWindow.focus(); }
      catch (e) { log('iframe focus failed: ' + e.message); }
    }, 100);
  }

  // -------- Exit guardrails ------------------------------------------------
  function armInactivity() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      simid.reportTracking('inactivity').catch(() => {});
      log(`Inactivity ${INACTIVITY_MS}ms — auto-skip`);
      teardown('inactivity');
    }, INACTIVITY_MS);
  }

  function armHardCap() {
    clearTimeout(hardCapTimer);
    hardCapTimer = setTimeout(() => {
      simid.reportTracking('hardCap').catch(() => {});
      log(`Hard cap ${HARD_CAP_MS}ms — force exit`);
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
    // Resume the linear so it can play out + fire complete tracking.
    simid.requestPlay().catch(() => {});
    // Tell the player to take the ad slot down.
    simid.requestStop(reason).catch(() => {});
  }

  // -------- Input ----------------------------------------------------------
  // We listen at the parent level too so we can catch Back / OK on the Skip
  // button. Game-internal D-pad navigation is handled by the iframe's own
  // listener once it has focus.
  document.addEventListener('keydown', (e) => {
    if (!started || dismissed) return;
    pokeInactivity();

    if (matchKey(e, KEY.BACK)) {
      simid.reportTracking('skip').catch(() => {});
      simid.requestSkip().catch(() => {});
      teardown('user-skip');
      e.preventDefault();
      return;
    }

    // OK on the focused Skip button skips. Otherwise OK falls through to
    // the iframe (its keydown listener gets it because it has focus).
    if (matchKey(e, KEY.OK) && document.activeElement === skipBtn) {
      simid.reportTracking('skip').catch(() => {});
      teardown('user-skip-button');
      e.preventDefault();
      return;
    }

    // Up arrow — pull focus to the Skip button. Provides a way to escape
    // the game without exiting the ad if the user wants to confirm skip.
    if (matchKey(e, KEY.UP) && document.activeElement === iframe) {
      skipBtn.focus();
      e.preventDefault();
      return;
    }
    if (matchKey(e, KEY.DOWN) && document.activeElement === skipBtn) {
      try { iframe.contentWindow.focus(); } catch {}
      e.preventDefault();
      return;
    }
  });

  skipBtn.addEventListener('click', () => {
    simid.reportTracking('skip').catch(() => {});
    teardown('user-skip-button');
  });

  // -------- Game completion signals ----------------------------------------
  // The Allkinds game may post messages on win/lose. Listen for any
  // recognisable completion event and tear down cleanly. We also forward
  // every message to the HUD for diagnostics.
  window.addEventListener('message', (event) => {
    let payload = event.data;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { /* not JSON */ }
    }
    if (!payload || typeof payload !== 'object') return;

    // Skip SIMID envelopes — those go to the SIMID protocol handler.
    if (typeof payload.type === 'string' &&
        (payload.type.indexOf('SIMID:') === 0 ||
         payload.type === 'resolve' ||
         payload.type === 'reject' ||
         payload.type === 'createSession')) {
      return;
    }

    // Game-emitted events. We don't know the exact schema yet — accept
    // multiple common shapes.
    const evtName = payload.event || payload.type || payload.action;
    if (!evtName) return;

    log('Game event: ' + evtName);

    if (/^(complete|completed|finish|finished|win|won|gameOver|gameComplete)$/i.test(evtName)) {
      simid.reportTracking('gameComplete', payload).catch(() => {});
      // Small delay so the game's own end-screen has time to appear.
      setTimeout(() => teardown('game-complete'), 1500);
    }
  });

  // Activity heartbeat — any keypress, any incoming game message resets
  // the inactivity timer.
  document.addEventListener('keydown', () => pokeInactivity(), true);

  // Kick off the SIMID handshake.
  simid.createSession();
  simid.ready().catch(() => {});
})();
