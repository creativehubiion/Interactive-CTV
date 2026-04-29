/**
 * Interactive CTV ad — D-pad-driven 2x2 selector running inside a SIMID iframe.
 *
 * Remote keys (Fire TV / Android TV WebView):
 *   ArrowUp/Down/Left/Right  - move focus across the grid
 *   Enter                    - confirm selection (D-pad center / OK)
 *   Escape / Backspace       - skip the ad
 *   GoBack (212/166)         - skip the ad (some Fire TV remotes)
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

  const simid = new SimidCreative();
  let started = false;
  let dismissed = false;
  let watchdog  = null;

  // -------- Lifecycle ------------------------------------------------------
  simid.addEventListener('init', () => {
    simid.log('creative:init received');
    log('Player:init handled');
    // We do not show the UI yet — wait for Player:startCreative.
  });

  simid.addEventListener('start', () => {
    if (started) return;
    started = true;
    simid.log('creative:start received');
    log('Player:startCreative — showing UI');

    // Pause the video while user is interacting; many CTV stacks already pause
    // for SIMID linears, but request explicitly to be safe.
    simid.requestPause().catch(() => {});

    showStage();
    armWatchdog();
    simid.reportTracking('creativeView').catch(() => {});
  });

  simid.addEventListener('stopped', () => teardown('player-stopped'));
  simid.addEventListener('skipped', () => teardown('player-skipped'));

  // Some hosts never deliver Player:startCreative when running outside IMA.
  // If we see Player:init but no startCreative within 2s, start anyway.
  setTimeout(() => {
    if (!started) {
      simid.log('startCreative not received within 2s; auto-starting');
      log('No startCreative in 2s — falling back to auto-start');
      started = true;
      showStage();
      armWatchdog();
    }
  }, 2000);

  // -------- UI / Focus -----------------------------------------------------
  const stage    = document.getElementById('stage');
  const grid     = document.getElementById('grid');
  const tiles    = Array.from(document.querySelectorAll('.tile'));
  const confirm  = document.getElementById('confirm');
  const cTitle   = document.getElementById('confirm-title');
  const cBody    = document.getElementById('confirm-body');

  // Build a row/col map for spatial nav.
  const layout = {};
  tiles.forEach(t => {
    const r = Number(t.dataset.row);
    const c = Number(t.dataset.col);
    (layout[r] = layout[r] || {})[c] = t;
  });
  const rows = Object.keys(layout).map(Number).sort();
  const cols = Object.keys(layout[rows[0]]).map(Number).sort();

  function focusedCoords() {
    const el = document.activeElement;
    if (!el || !el.dataset || el.dataset.row == null) return [rows[0], cols[0]];
    return [Number(el.dataset.row), Number(el.dataset.col)];
  }

  function move(dr, dc) {
    let [r, c] = focusedCoords();
    r = Math.min(rows[rows.length - 1], Math.max(rows[0], r + dr));
    c = Math.min(cols[cols.length - 1], Math.max(cols[0], c + dc));
    const target = layout[r] && layout[r][c];
    if (target) target.focus();
  }

  function showStage() {
    stage.classList.add('visible');
    stage.setAttribute('aria-hidden', 'false');
    // Critical for CTV WebView iframes: explicitly grab focus.
    window.focus();
    const first = tiles[0];
    if (first) first.focus();
  }

  function armWatchdog() {
    // If user does nothing for 15s, dismiss politely.
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (!dismissed) {
        simid.reportTracking('timeout').catch(() => {});
        teardown('timeout');
      }
    }, 15000);
  }

  function pokeWatchdog() {
    armWatchdog();
  }

  function selectTile(tile) {
    const id = tile.dataset.id;
    const label = tile.querySelector('.tile-label')?.textContent || id;
    simid.reportTracking('select', { id }).catch(() => {});
    simid.log(`user selected: ${id}`);
    log(`User selected: ${id}`);

    cTitle.textContent = `Nice pick — ${label}.`;
    cBody.textContent  = 'Returning you to your show…';
    confirm.classList.remove('hidden');

    setTimeout(() => teardown('completed'), 1800);
  }

  function teardown(reason) {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(watchdog);
    stage.classList.remove('visible');
    stage.setAttribute('aria-hidden', 'true');
    log(`Teardown: ${reason}`);
    // Ask the player to resume the underlying content.
    simid.requestPlay().catch(() => {});
    // Tell the player to take the ad slot down.
    simid.requestStop(reason).catch(() => {});
  }

  // -------- Input ----------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (!started || dismissed) return;
    pokeWatchdog();

    if (matchKey(e, KEY.LEFT))  { move(0, -1); e.preventDefault(); return; }
    if (matchKey(e, KEY.RIGHT)) { move(0,  1); e.preventDefault(); return; }
    if (matchKey(e, KEY.UP))    { move(-1, 0); e.preventDefault(); return; }
    if (matchKey(e, KEY.DOWN))  { move( 1, 0); e.preventDefault(); return; }

    if (matchKey(e, KEY.OK))   {
      const el = document.activeElement;
      if (el && el.classList.contains('tile')) selectTile(el);
      e.preventDefault();
      return;
    }

    if (matchKey(e, KEY.BACK)) {
      simid.reportTracking('skip').catch(() => {});
      simid.requestSkip().catch(() => {});
      teardown('user-skip');
      e.preventDefault();
      return;
    }
  });

  // Click fallback for desktop testing.
  tiles.forEach(t => t.addEventListener('click', () => selectTile(t)));

  // Kick off the SIMID handshake. Per Google's reference creative, the
  // creative initiates the session — this generates a UUID and sends
  // `createSession` to the player; the player then replies with Player:init.
  simid.createSession();

  // Ready signal — some players wait for this before showing the iframe.
  // (Sent independently of init; harmless to send before init resolves.)
  simid.ready().catch(() => {});
})();
