/**
 * Catch-the-fruit mini-game. Pure DOM — no canvas, no game library.
 * Tuned to run cheaply on a 2nd-gen Fire Stick.
 *
 * - Player (🧺) moves left/right with D-pad. Continuous hold-to-move.
 * - Items fall from the top: fruits = +1, bombs = -1.
 * - 30-second round. Score persists across the run; end card shows total.
 * - All state lives on the FruitCatchGame instance — no globals leak.
 *
 * Public API:
 *   const g = new FruitCatchGame(opts);
 *   g.start();      // begin spawning + game loop
 *   g.stop();       // halt + clean up
 *   g.events.on('end', score => ...);   // round-complete callback
 *   g.events.on('score', s => ...);     // score-change callback
 *   g.handleKey(direction);             // 'left' | 'right' from input layer
 */
(function (global) {
  'use strict';

  const ROUND_MS  = 30_000;
  const SPAWN_MIN_MS = 850;
  const SPAWN_MAX_MS = 1500;
  const FALL_MIN_PX_PER_S = 180;
  const FALL_MAX_PX_PER_S = 290;
  const PLAYER_SPEED_PX_PER_S = 900;
  // Emoji choices intentionally limited to Emoji 1.0–3.0 era (2014-2015)
  // glyphs so older Android/Fire OS bundled emoji fonts render every
  // item. 🪨 (Emoji 13.0, 2020) and 🧺 (11.0, 2018) showed as tofu on
  // Fire OS 7 — basket is now an inline SVG, bombs only.
  const GOOD_ITEMS = ['🍎', '🍓', '🍇', '🍌', '🥝', '🍑', '🍊'];
  const BAD_ITEMS  = ['💣'];
  const BAD_PROB   = 0.18;

  // ---- Synthesized SFX -----------------------------------------------------
  // Zero-asset sound: built from oscillators on the fly. No network, no
  // autoplay-policy issues once any user gesture has touched the page.
  class SoundFx {
    constructor() { this.ctx = null; this.master = null; this.muted = false; }
    _ensure() {
      if (this.ctx) return this.ctx;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try {
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      } catch { return null; }
      return this.ctx;
    }
    /** Call from the first user gesture. Some browsers lock the AudioContext
     *  in a 'suspended' state until then. */
    unlock() {
      const c = this._ensure();
      if (c && c.state === 'suspended') { try { c.resume(); } catch {} }
    }
    _tone({ freq, type = 'sine', duration = 150, volume = 0.25, slideSemitones = 0, attack = 0.005 }) {
      const ctx = this._ensure();
      if (!ctx || this.muted) return;
      const t0 = ctx.currentTime;
      const t1 = t0 + duration / 1000;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideSemitones) {
        const target = freq * Math.pow(2, slideSemitones / 12);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, target), t1);
      }
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    good()  { this._tone({ freq: 660, type: 'triangle', duration: 110, volume: 0.30, slideSemitones:  7 }); }
    bad()   { this._tone({ freq: 220, type: 'square',   duration: 200, volume: 0.22, slideSemitones: -7 }); }
    move()  { /* intentionally silent — would be annoying on hold-to-move */ }
    start() {
      this._tone({ freq: 440, type: 'sine', duration: 90,  volume: 0.22 });
      setTimeout(() => this._tone({ freq: 660, type: 'sine', duration: 90,  volume: 0.22 }), 100);
      setTimeout(() => this._tone({ freq: 880, type: 'sine', duration: 140, volume: 0.22 }), 200);
    }
    end() {
      this._tone({ freq: 880, type: 'triangle', duration: 180, volume: 0.28 });
      setTimeout(() => this._tone({ freq: 660, type: 'triangle', duration: 180, volume: 0.28 }), 180);
      setTimeout(() => this._tone({ freq: 440, type: 'triangle', duration: 380, volume: 0.28 }), 360);
    }
    tick()  { this._tone({ freq: 1200, type: 'sine', duration: 40, volume: 0.10 }); }
  }
  global.GameSfx = new SoundFx();

  class TinyEmitter {
    constructor() { this._h = {}; }
    on(name, fn)  { (this._h[name] = this._h[name] || []).push(fn); }
    emit(name, x) { (this._h[name] || []).forEach(fn => fn(x)); }
  }

  class FruitCatchGame {
    constructor({ field, player, scoreEl, timerEl, endcard, endTitle, endScoreEl } = {}) {
      this.fieldEl   = field;
      this.playerEl  = player;
      this.scoreEl   = scoreEl;
      this.timerEl   = timerEl;
      this.endcard   = endcard;
      this.endTitle  = endTitle;
      this.endScoreEl = endScoreEl;
      this.events    = new TinyEmitter();

      this.score = 0;
      this.items = [];          // {el, x, y, vy, kind}
      this.playerX = 0;         // px from field-left, center of basket
      this.playerW = 110;       // approx player width in px (recomputed on start)
      this.playerH = 130;
      this.fieldW  = 0;
      this.fieldH  = 0;
      this.running = false;
      this.lastFrame = 0;
      this.lastSpawn = 0;
      this.nextSpawnGap = SPAWN_MIN_MS;
      this.startedAt = 0;
      this.holdDir = 0;         // -1 left, 0 idle, +1 right

      this._loop = this._loop.bind(this);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.score = 0;
      this.items = [];
      this.fieldEl.querySelectorAll('.item, .score-burst').forEach(n => n.remove());
      this._measure();
      this.playerX = this.fieldW / 2;
      this._renderPlayer();
      this._renderScore();
      this.startedAt = performance.now();
      this.lastFrame = this.startedAt;
      this.lastSpawn = this.startedAt;
      this.nextSpawnGap = this._randSpawnGap();
      this._lastTickSec = 999;
      this.endcard && this.endcard.classList.add('hidden');
      if (global.GameSfx) global.GameSfx.start();
      requestAnimationFrame(this._loop);
    }

    stop() {
      this.running = false;
      this.holdDir = 0;
    }

    handleKey(dir, pressed) {
      // dir: 'left' | 'right'. pressed=true on keydown, false on keyup.
      if (!this.running) return;
      if (dir === 'left')  this.holdDir = pressed ? -1 : (this.holdDir === -1 ? 0 : this.holdDir);
      if (dir === 'right') this.holdDir = pressed ? +1 : (this.holdDir === +1 ? 0 : this.holdDir);
    }

    _measure() {
      const rect = this.fieldEl.getBoundingClientRect();
      this.fieldW = rect.width;
      this.fieldH = rect.height;
      const p = this.playerEl.getBoundingClientRect();
      if (p.width)  this.playerW = p.width;
      if (p.height) this.playerH = p.height;
    }

    _randSpawnGap() {
      return SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
    }

    _spawn() {
      const isBad = Math.random() < BAD_PROB;
      const list  = isBad ? BAD_ITEMS : GOOD_ITEMS;
      const glyph = list[Math.floor(Math.random() * list.length)];
      const el = document.createElement('div');
      el.className = 'item';
      el.textContent = glyph;
      const widthEstimate = 70;
      const x = widthEstimate / 2 + Math.random() * (this.fieldW - widthEstimate);
      el.style.left = (x - widthEstimate / 2) + 'px';
      el.style.top  = '0px';
      el.style.transform = 'translate3d(0, 0, 0)';
      this.fieldEl.appendChild(el);
      this.items.push({
        el,
        x,
        y: 0,
        vy: FALL_MIN_PX_PER_S + Math.random() * (FALL_MAX_PX_PER_S - FALL_MIN_PX_PER_S),
        good: !isBad,
        w: widthEstimate,
        h: widthEstimate,
      });
    }

    _renderPlayer() {
      const half = this.playerW / 2;
      const min = half;
      const max = this.fieldW - half;
      this.playerX = Math.max(min, Math.min(max, this.playerX));
      this.playerEl.style.transform =
        `translate3d(${this.playerX - this.fieldW / 2}px, 0, 0)`;
    }

    _renderScore() {
      this.scoreEl.textContent = String(this.score);
      this.events.emit('score', this.score);
    }

    _showBurst(x, y, isGood) {
      const b = document.createElement('div');
      b.className = 'score-burst ' + (isGood ? 'good' : 'bad');
      b.textContent = isGood ? '+1' : '-1';
      b.style.left = x + 'px';
      b.style.top  = y + 'px';
      this.fieldEl.appendChild(b);
      setTimeout(() => b.remove(), 700);
    }

    _loop(now) {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
      this.lastFrame = now;

      // Timer
      const elapsed = now - this.startedAt;
      const remainingMs = Math.max(0, ROUND_MS - elapsed);
      const sec = Math.ceil(remainingMs / 1000);
      const mm = Math.floor(sec / 60);
      const ss = String(sec % 60).padStart(2, '0');
      this.timerEl.textContent = `${mm}:${ss}`;

      if (remainingMs <= 0) {
        this._end();
        return;
      }

      // Player movement
      if (this.holdDir !== 0) {
        this.playerX += this.holdDir * PLAYER_SPEED_PX_PER_S * dt;
        this._renderPlayer();
      }

      // Spawn
      if (now - this.lastSpawn >= this.nextSpawnGap) {
        this._spawn();
        this.lastSpawn = now;
        this.nextSpawnGap = this._randSpawnGap();
      }

      // Update items
      const playerLeft  = this.playerX - this.playerW / 2;
      const playerRight = this.playerX + this.playerW / 2;
      const playerTop   = this.fieldH - this.playerH;
      const playerBot   = this.fieldH;

      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        it.y += it.vy * dt;
        it.el.style.transform = `translate3d(0, ${it.y}px, 0)`;

        const itLeft = it.x - it.w / 2;
        const itRight = it.x + it.w / 2;
        const itTop  = it.y;
        const itBot  = it.y + it.h;

        const hitsPlayer = (
          itBot >= playerTop && itTop <= playerBot &&
          itRight >= playerLeft && itLeft <= playerRight
        );

        if (hitsPlayer) {
          this.score += it.good ? 1 : -1;
          if (this.score < 0) this.score = 0;
          this._renderScore();
          this._showBurst(it.x, this.fieldH - this.playerH - 10, it.good);
          if (global.GameSfx) (it.good ? global.GameSfx.good() : global.GameSfx.bad());
          it.el.remove();
          this.items.splice(i, 1);
          continue;
        }

        if (itTop > this.fieldH) {
          it.el.remove();
          this.items.splice(i, 1);
        }
      }

      requestAnimationFrame(this._loop);
    }

    _end() {
      this.running = false;
      if (global.GameSfx) global.GameSfx.end();
      if (this.endTitle)    this.endTitle.textContent = "Time's up!";
      if (this.endScoreEl)  this.endScoreEl.textContent = String(this.score);
      if (this.endcard)     this.endcard.classList.remove('hidden');
      this.events.emit('end', this.score);
    }
  }

  global.FruitCatchGame = FruitCatchGame;
})(window);
