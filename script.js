'use strict';
/* ---------- Config ---------- */
const CLIPS = [0.5, 1, 2, 4, 8, 16];            // Songless: seconds per attempt
const STEMS = ['drums', 'bass', 'other', 'vocals'];   // Bandle: stem files made by make_stems.py
const LANE_NAMES = ['Drums', 'Bass', 'Music', 'Vocals'];   // Bandle: one waveform lane per stem, in STEMS order
const LANE_CAPS = ['named on 1 instrument', 'named on 2 instruments', 'named on 3 instruments', 'named with the full band'];
const BARS = 48;                               // bars drawn per lane
const EPOCH = Date.UTC(2025, 0, 1);            // Daily #1 = this date (UTC, so everyone matches)
const SONGS_PER_ROUND = 5;                     // one "round" = this many songs
// Popularity tiers come from each song's Deezer "rank" (fetch_popularity.py): thirds per language, per game.
const TIERS = [{ id: 'hits', label: 'Hits' }, { id: 'familiar', label: 'Familiar' }, { id: 'deep', label: 'Deep cuts' }];
const DAILY_PLAN = ['hits', 'hits', 'familiar', 'familiar', 'deep'];   // Daily: 2 easy, 2 medium, 1 expert
const levelOf = k => k < 2 ? 0 : k < 4 ? 1 : 2;                       // song number -> 0 easy, 1 medium, 2 expert

// One config per game. Everything game-specific lives here; the round, scoring and menu code reads G.
// Scoring: every song starts at `start`. Revealing more (skip) costs `step`, a wrong guess costs `wrong`
// (and does NOT reveal more audio). Reaching 0 points, or giving up, scores 0.
const GAMES = {
  songless: {
    id: 'songless', name: 'Songless', stems: false, seed: 0,
    blurb: '5 songs a round. The shorter the clip, the more points.',
    start: 10000, step: 1000, wrong: 500,
    stages: CLIPS.map(c => ({ label: c + 's', sec: c })),
    skipLabel: 'Skip',
    eligible: () => true
  },
  bandle: {
    id: 'bandle', name: 'Bandle', stems: true, seed: 1000,      // different seed = different daily songs than Songless
    blurb: '5 songs a round. Hear the drums first, then bass, then the full band. Each reveal costs 2,000.',
    start: 10000, step: 2000, wrong: 500,
    stages: [                                                     // layers build up; each stage plays the whole clip
      { label: 'Drums',  name: 'Drums',            layers: ['drums'] },
      { label: '+ Bass', name: 'Drums + bass',     layers: ['drums', 'bass'] },
      { label: '+ Music', name: 'Music only',      layers: ['drums', 'bass', 'other'] },
      { label: 'Full',   name: 'Original song',    layers: STEMS }
    ],
    skipLabel: 'Reveal next',
    eligible: s => !!s.stems && STEMS.every(n => s.stems[n])    // only songs that make_stems.py has processed
  }
};
let G = GAMES.songless;                         // the game currently selected
const stageCount = () => G.stages.length;
const pk = k => G.id + '.' + k;                 // per-game storage key (songless keys stay 'songless.*')

/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
const dayNumber = () => Math.floor((Date.now() - EPOCH) / 864e5);
// Deterministic hash so the same day always maps to the same song index.
function dailyIndex(n, len) {
  let h = Math.imul(n + 1, 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return (h >>> 0) % len;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ---------- Animation helpers ---------- */
function pulse(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }   // restart a CSS animation
function countUp(el, to, fmtFn, ms = 900) {       // ease-out number count-up
  const t0 = performance.now();
  (function step(t) {
    const p = Math.min((t - t0) / ms, 1), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtFn(Math.round(to * e));
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}
function burst() {                                  // confetti: pieces fall and remove themselves
  const colors = ['#6d83ff', '#a35cff', '#3ee6a8', '#4cc9f0', '#c084fc', '#f5efe6'];
  for (let i = 0; i < 46; i++) {
    const c = document.createElement('i'); c.className = 'conf';
    c.style.cssText = `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};--dx:${(Math.random() - .5) * 240}px;` +
      `--r:${Math.random() * 900 - 450}deg;--t:${(1.8 + Math.random() * 1.4).toFixed(2)}s;animation-delay:${(Math.random() * .4).toFixed(2)}s`;
    document.body.appendChild(c); setTimeout(() => c.remove(), 3800);
  }
}

/* ---------- Sound effects (synthesised with Web Audio, no files needed) ---------- */
let sfxOn = store.get('songless.sfx', true);
function tone(f, t0, dur, type = 'sine', vol = .2, f2) {   // one enveloped note, optional pitch slide to f2
  const c = audioCtx(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime + t0;
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol * 1.3, t + 0.012);   // 1.3 = overall UI-sound loudness
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(sfxGain); o.start(t); o.stop(t + dur + 0.05);
}
const SFX = {
  start() { [392, 523, 659, 784].forEach((f, i) => tone(f, i * .06, .24, 'triangle', .2)); tone(196, 0, .35, 'sine', .16, 392); },  // rising sparkle
  back()  { tone(520, 0, .12, 'triangle', .2, 330); tone(330, .09, .18, 'triangle', .18, 220); },                                     // soft descend
  next()  { tone(300, 0, .24, 'sine', .16, 900); tone(600, .05, .2, 'triangle', .08, 1500); },                                         // whoosh up
  skip()  { tone(700, 0, .13, 'sawtooth', .12, 240); },                                                                                // quick swish
  wrong() { tone(170, 0, .24, 'sawtooth', .15, 90); tone(120, .12, .26, 'square', .07, 70); },                                         // buzzer thud
  win()   { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * .09, .32, 'triangle', .22)); tone(1568, .38, .5, 'sine', .14); },    // bright arpeggio
  lose()  { [392, 349, 311, 262].forEach((f, i) => tone(f, i * .14, .32, 'triangle', .17)); },                                         // sad descent
  final(best) {                                                                                                                         // end-of-round score reveal
    for (let i = 0; i < 18; i++) tone(500 + i * 45, i * .075, .06, 'square', .09);                                                       // rising tally roll while the score counts up
    [262, 330, 392, 523].forEach(f => tone(f, 1.4, .9, 'triangle', .22));                                                                // big chord when it lands
    tone(1047, 1.4, .8, 'sine', .18); tone(131, 1.4, 1.0, 'sine', .25);
    if (best) [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 1.9 + i * .08, .5, 'triangle', .2));                          // extra fanfare for a new best
  },
  tick()  { tone(900, 0, .05, 'square', .1); tone(1350, .02, .04, 'square', .05); },                                                                                       // tiny click
};
function sfx(name, arg) {
  if (!sfxOn) return;
  try { const c = audioCtx(); c.resume(); sfxGain.gain.value = +$('vol').value * 1.2; SFX[name](arg); } catch {}   // follows the volume slider
}

/* ---------- Audio (Web Audio API) ----------
   AudioBufferSourceNode.start(when, offset, duration) schedules the stop on the audio
   clock, so clips end exactly on time with no bleed (unlike setTimeout + pause()). */
const band = { pos: 0, dur: 30, from: 0, when: 0, on: false, raf: 0, lit: -1 };   // Bandle playhead: pos/dur in seconds
let ctx, gain, sfxGain, source = null, sources = [], playToken = 0;   // source = Songless clip, sources = Bandle stems
const buffers = new Map();                      // src -> Promise<AudioBuffer>
function audioCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    gain = ctx.createGain(); gain.gain.value = +$('vol').value; gain.connect(ctx.destination);
    sfxGain = ctx.createGain(); const lim = ctx.createDynamicsCompressor();   // separate bus for UI sounds; the compressor stops stacked notes clipping
    sfxGain.connect(lim); lim.connect(ctx.destination);
  }
  return ctx;
}
const fetchDecode = url => fetch(url)
  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
  .then(b => audioCtx().decodeAudioData(b));
function loadBuffer(song) {                     // fetch + decode once, then cache (preload)
  if (!buffers.has(song.src)) {
    const p = fetchDecode(song.src);
    p.catch(() => buffers.delete(song.src));    // allow retry after a failure
    buffers.set(song.src, p);
  }
  return buffers.get(song.src);
}
// Bandle: the four stems of one song, decoded together. A decoded song is ~40 MB, so only the last few are kept.
const stemCache = new Map();                    // first stem path -> Promise<{drums, bass, other, vocals}>
function loadStems(song) {
  const k = song.stems.drums;
  if (!stemCache.has(k)) {
    const p = Promise.all(STEMS.map(n => fetchDecode(song.stems[n])))
      .then(a => Object.fromEntries(STEMS.map((n, i) => [n, a[i]])));
    p.catch(() => stemCache.delete(k));
    stemCache.set(k, p);
    while (stemCache.size > 3) stemCache.delete(stemCache.keys().next().value);
  }
  return stemCache.get(k);
}
const RING = 2 * Math.PI * 56;                  // circumference of the progress ring (r = 56)
function setBar(seconds, fraction) {            // sweep the ring over `seconds`; stop = reset
  const ring = $('ring');
  ring.style.transition = 'none'; ring.style.strokeDashoffset = RING;
  $('stage').classList.toggle('playing', !!seconds);
  syncPlay();
  if (!seconds) return;
  void ring.getBoundingClientRect();            // force reflow so the transition restarts
  ring.style.transition = `stroke-dashoffset ${seconds}s linear`; ring.style.strokeDashoffset = RING * (1 - fraction);
}
const isPlaying = () => !!(source || el || sources.length);
function stopAudio() {
  playToken++; band.on = false; cancelAnimationFrame(band.raf);   // band.pos stays where it stopped
  if (source) { source.onended = null; try { source.stop(); } catch {} source = null; }
  sources.forEach(s => { s.onended = null; try { s.stop(); } catch {} }); sources = [];
  if (el) { el.pause(); el = null; }
  setBar(0);
}
// duration undefined = play to the end of the song (used on the end screen)
async function playSong(song, duration) {
  stopAudio();
  const token = playToken;
  let buf;
  try { buf = await loadBuffer(song); }
  catch (e) { return playViaElement(song, duration, token); }
  if (token !== playToken) return;              // a newer play/stop request superseded this one
  const c = audioCtx(); await c.resume();
  if (token !== playToken) return;
  const offset = Math.min(song.start || 0, Math.max(buf.duration - 0.1, 0));
  const dur = duration ?? buf.duration - offset;
  source = c.createBufferSource(); source.buffer = buf; source.connect(gain);
  source.start(0, offset, dur);
  const mine = source;
  source.onended = () => { if (source === mine) { source = null; setBar(0); } };
  setBar(dur, duration ? duration / CLIPS[CLIPS.length - 1] : 1);
}
// Bandle: play the chosen stems together, all started at the same audio-clock time so they stay in sync.
async function playStage(song, layers, from = 0) {
  stopAudio();
  const token = playToken;
  let bufs;
  try { bufs = await loadStems(song); }
  catch (e) { toast('Couldn’t load the stems for this song. Run make_stems.py and serve the folder over http.'); return; }
  if (token !== playToken) return;
  const c = audioCtx(); await c.resume();
  if (token !== playToken) return;
  const when = c.currentTime + 0.06;
  const dur = Math.min(...STEMS.map(n => bufs[n].duration));
  const off = Math.min(Math.max(from, 0), dur - 0.1);      // start part-way in when the player scrubbed
  sources = layers.map(n => { const s = c.createBufferSource(); s.buffer = bufs[n]; s.connect(gain); s.start(when, off, dur - off); return s; });
  const first = sources[0];
  first.onended = () => { if (sources[0] === first) { sources = []; setBar(0); band.on = false; band.pos = 0; paintPos(); } };
  Object.assign(band, { dur, from: off, when, on: true });
  setBar(dur - off, 1); bandTick();
}

/* ---------- Fallback: HTMLAudioElement ----------
   Used when a remote file (e.g. iTunes previews) can't be fetched due to CORS. Plays fine without
   CORS, but the stop is checked once per animation frame, so a clip can overrun by ~16ms. */
let el = null;
const elCache = new Map();                      // src -> preloaded <audio>
function getEl(song) {
  if (!elCache.has(song.src)) {
    const a = new Audio(); a.preload = 'auto'; a.src = song.src; elCache.set(song.src, a);
  }
  return elCache.get(song.src);
}
function playViaElement(song, duration, token) {
  const a = getEl(song), offset = song.start || 0;
  a.volume = +$('vol').value;
  const go = () => {
    if (token !== playToken) return;
    a.currentTime = offset;
    a.play().then(() => {
      if (token !== playToken) { a.pause(); return; }
      el = a;
      const end = duration === undefined ? Infinity : offset + duration;
      setBar(duration ?? Math.max(a.duration - offset, 0), duration ? duration / CLIPS[CLIPS.length - 1] : 1);
      (function tick() {
        if (token !== playToken) return;
        if (a.currentTime >= end || a.ended) { a.pause(); el = null; setBar(0); return; }
        requestAnimationFrame(tick);
      })();
    }).catch(() => toast(`Couldn't load "${song.src}". Check the path or your connection.`));
  };
  a.readyState >= 1 ? go() : a.addEventListener('loadedmetadata', go, { once: true });
}
const preload = song => G.stems ? loadStems(song).catch(() => {}) : loadBuffer(song).catch(() => getEl(song));

/* ---------- State ---------- */
const fmt = n => n.toLocaleString('en-US');
let songs = [], mode = 'daily', round = null, game = null, selected = null, bag = [];
const statsKey = (m, g = G) => g.id + '.stats.' + m;
const highKey = (m, g = G) => g.id + '.high.' + m;     // best round total per game and mode
const dailyKey = () => G.id + '.daily';
const total = () => game.scores.reduce((x, y) => x + y, 0);
const eligibleIdx = () => [...songs.keys()].filter(i => G.eligible(songs[i]));
const tierOf = s => s._tier && s._tier[G.id];
function assignTiers() {                        // thirds by rank within each language, separately for each game's song set
  songs.forEach(s => { s._tier = {}; });
  Object.values(GAMES).forEach(g => ['zh', 'en'].forEach(l => {
    const grp = songs.filter(s => g.eligible(s) && s._lang === l && Number.isFinite(s.rank)).sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
    grp.forEach((s, i) => { s._tier[g.id] = TIERS[Math.floor(i * 3 / grp.length)].id; });
  }));
}
const isTieredOrder = order => order.length === DAILY_PLAN.length && order.every((i, k) => tierOf(songs[i]) === DAILY_PLAN[k]);
function dailyOrder(pool, n) {                  // same five songs for everyone today; falls back to a plain shuffle if tiers are missing
  const seed = dayNumber() + 1 + G.seed;
  if (n === DAILY_PLAN.length) {
    const by = Object.fromEntries(TIERS.map((t, k) => [t.id, seededShuffle(pool.filter(i => tierOf(songs[i]) === t.id), seed + 7 * (k + 1))]));
    const need = {}; DAILY_PLAN.forEach(t => { need[t] = (need[t] || 0) + 1; });
    if (TIERS.every(t => by[t.id].length >= (need[t.id] || 0))) {
      const used = {};
      return DAILY_PLAN.map(t => by[t][used[t] = (used[t] ?? -1) + 1]);
    }
  }
  return seededShuffle(pool, seed).slice(0, n);
}

function seededShuffle(arr, seed) {            // mulberry32: same seed -> same order for everyone
  let t = seed >>> 0; const a = arr.slice();
  const rnd = () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// game = one round of N songs; round = the song currently being guessed
function startRound(saved) {
  const idx = game.order[game.pos], song = songs[idx];
  round = { idx, song, skips: saved?.skips || 0, wrongs: saved?.wrongs || [], over: !!saved?.over, won: !!saved?.won };
  selected = null; $('input').value = '';
  $('stage').classList.remove('win', 'lose');
  if (G.stems) {                                // draw this song's real waveforms once its stems are decoded
    band.pos = 0; band.dur = song._dur || 30; paintPos(); paintPeaks(song._peaks || null);
    loadStems(song).then(b => {
      song._peaks = song._peaks || computePeaks(b); song._dur = Math.min(...STEMS.map(n => b[n].duration));
      if (round && round.song === song) { paintPeaks(song._peaks); band.dur = song._dur; paintPos(); }
    }).catch(() => {});
  }
  preload(song);                                // preload so the first clip plays instantly
  const nxt = game.order[game.pos + 1]; if (nxt !== undefined) preload(songs[nxt]);
  render();
}
function newGame() {
  const pool = mode === 'daily' ? eligibleIdx() : poolIdx();   // Unlimited honours the artist filter
  const n = Math.min(SONGS_PER_ROUND, pool.length);
  let order = [];
  if (mode === 'daily') order = dailyOrder(pool, n);
  else {
    bag = bag.filter(i => pool.includes(i));
    while (order.length < n) {                  // no repeats until the whole pool is exhausted
      if (!bag.length) bag = shuffle(pool.filter(i => !order.includes(i)));
      order.push(bag.pop());
    }
  }
  game = { order, pool, pos: 0, rows: [], scores: [], complete: false, viewFinal: false, newBest: false, tiered: mode === 'daily' && isTieredOrder(order) };
  startRound();
}
function setMode(m) {
  stopAudio(); mode = m; store.set('songless.mode', m);
  const sv = m === 'daily' ? store.get(dailyKey(), null) : null;
  if (sv && sv.day === dayNumber() && sv.v === 2 && Array.isArray(sv.order) && sv.order.every(i => songs[i] && G.eligible(songs[i]))) {
    game = { order: sv.order, pos: sv.pos, rows: sv.rows, scores: sv.scores, complete: sv.complete, viewFinal: sv.complete, newBest: false, pool: eligibleIdx(), tiered: isTieredOrder(sv.order) };
    startRound(sv);                             // restore today's progress
  } else newGame();
}
function persist() {
  if (mode === 'daily') store.set(dailyKey(), { v: 2, day: dayNumber(), order: game.order, pos: game.pos,
    rows: game.rows, scores: game.scores, complete: game.complete, skips: round.skips, wrongs: round.wrongs, over: round.over, won: round.won });
}

/* ---------- Gameplay ---------- */
const worth = r => Math.max(0, G.start - G.step * r.skips - G.wrong * r.wrongs.length);
const playFull = song => G.stems ? (band.pos = 0, playStage(song, STEMS, 0)) : playSong(song);   // end screen: the whole song
function finish(won) {
  round.over = true; round.won = won;
  game.rows.push({ skips: round.skips, wrongs: round.wrongs.length, won });
  game.scores.push(won ? worth(round) : 0);
  const k = statsKey(mode);                     // per-song stats (distribution = which stage solved it)
  const s = store.get(k, { played: 0, wins: 0, streak: 0, max: 0, dist: Array(stageCount()).fill(0) });
  s.played++;
  if (won) { s.wins++; s.streak++; s.max = Math.max(s.max, s.streak); s.dist[round.skips]++; }
  else s.streak = 0;
  store.set(k, s);
  if (game.pos === game.order.length - 1) {     // last song: round complete, update high score now
    game.complete = true;
    game.newBest = total() > store.get(highKey(mode), 0);
    if (game.newBest) store.set(highKey(mode), total());
  }
  persist(); render();
  sfx(won ? 'win' : 'lose');
  const r = round;                              // reveal: a win starts the song together with the jingle; a miss waits for the sad jingle
  if (won) playFull(r.song);
  else setTimeout(() => { if (round === r && r.over) playFull(r.song); }, 750);
}
// Slide the current content out, run fn (which changes state), slide the new content in.
let swapping = false;
async function swap(fn) {
  if (swapping) return; swapping = true;
  const m = document.querySelector('main');
  m.classList.add('leaving'); await new Promise(r => setTimeout(r, 300));
  fn();
  m.classList.remove('leaving', 'entering'); void m.offsetWidth; m.classList.add('entering');
  swapping = false;                             // content has changed; the entrance animation just finishes on its own
  setTimeout(() => m.classList.remove('entering'), 900);
}
function nextSong() {
  stopAudio(); sfx('next');
  if (game.complete) swap(() => { game.viewFinal = true; render(); sfx('final', game.newBest); });   // sound lands with the count-up
  else swap(() => { game.pos++; startRound(); persist(); });
}
function submit() {
  if (round.over) return;
  if (selected === null) return toast('Pick a song from the list first.');
  const pick = selected; selected = null; $('input').value = '';
  if (round.wrongs.includes(pick)) return toast('You already tried that one.');
  if (pick === round.idx) return finish(true);
  round.wrongs.push(pick);                      // wrong guess: costs points, the audio stays the same
  pulse($('guessbox'), 'shake');
  if (worth(round) <= 0) return finish(false);
  sfx('wrong');
  persist(); render();
}
function skip() {
  if (round.over) return;
  if (round.skips >= stageCount() - 1) return finish(false);   // already on the last stage = "Give up"
  round.skips++; sfx('skip');
  if (G.stems) { stopAudio(); band.pos = 0; paintPos(); }   // Bandle: revealing the next layer restarts from the beginning
  persist(); render(); pulse($('stage'), 'pop');
  setTimeout(startClip, 160);                   // let the swish finish so it doesn't cover the start of the clip
}
const startClip = () => {
  const st = G.stages[round.skips];
  return G.stems ? playStage(round.song, st.layers, band.pos >= band.dur - 0.3 ? 0 : band.pos) : playSong(round.song, st.sec);   // Bandle resumes from the playhead
};
// Songless: Play always restarts the clip. Bandle: the clip is the whole preview, so Play toggles Play/Stop.
const playClip = () => (G.stems && isPlaying() ? stopAudio() : startClip());

/* ---------- Bandle lanes ---------- */
let barEls = [];
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function paintPos() {                           // move the playhead, light the bars it has passed, update the clock
  const L = $('lanes'), f = band.dur ? Math.min(band.pos / band.dur, 1) : 0;
  L.style.setProperty('--p', f);
  L.classList.toggle('armed', band.on || band.pos > 0.05);
  const lit = Math.round(f * BARS);
  if (lit !== band.lit) { band.lit = lit; barEls.forEach(b => b.classList.toggle('lit', b._k < lit)); }
  $('timeNow').textContent = `${mmss(band.pos)} / ${mmss(band.dur)}`;
}
function bandTick() {                           // follows the audio clock while stems play
  cancelAnimationFrame(band.raf);
  if (!band.on || !ctx) return;
  band.pos = Math.min(band.dur, band.from + Math.max(0, ctx.currentTime - band.when));
  paintPos(); band.raf = requestAnimationFrame(bandTick);
}
const startAt = sec => { band.pos = sec; return playStage(round.song, round.over ? STEMS : G.stages[round.skips].layers, sec); };
function seekBy(d) {                            // ±seconds: keeps playing if it was playing, otherwise just moves the playhead
  if (!G.stems || !round) return;
  const was = isPlaying(), t = Math.min(Math.max(band.pos + d, 0), band.dur - 0.1);
  band.pos = t; paintPos();
  if (was) startAt(t);
}
function buildLanes() {
  $('lanes').innerHTML = STEMS.map((n, i) => `<div class="lane" style="--c:var(--l${i})"><div class="lname"><b>${LANE_NAMES[i]}</b><small></small></div>` +
    `<div class="bars">${Array.from({ length: BARS }, (_, k) => `<i style="--k:${k}"></i>`).join('')}</div></div>`).join('') +
    '<div class="ph-track"><i class="ph"></i></div>';                // playhead overlay, aligned with the bars column
  barEls = [...$('lanes').querySelectorAll('.bars i')]; barEls.forEach(b => { b._k = +b.style.getPropertyValue('--k'); });
}
function computePeaks(bufs) {                   // loudness per bar for each stem, scaled so the loudest bar fills the lane
  return Object.fromEntries(STEMS.map(n => {
    const d = bufs[n].getChannelData(0), seg = Math.max(1, Math.floor(d.length / BARS)), out = [];
    for (let k = 0; k < BARS; k++) { let m = 0; for (let j = k * seg; j < (k + 1) * seg && j < d.length; j += 8) m = Math.max(m, Math.abs(d[j])); out.push(m); }
    const mx = Math.max(...out, 1e-6);
    return [n, out.map(v => Math.max(.08, Math.pow(v / mx, .6)))];
  }));
}
function paintPeaks(p) {                        // p = null while stems load: lanes stay low and flat
  [...$('lanes').querySelectorAll('.lane')].forEach((lane, i) => lane.querySelectorAll('.bars i').forEach((b, k) =>
    b.style.setProperty('--h', p ? p[STEMS[i]][k].toFixed(3) : '.12')));
}
function tweenTo(el, to, ms = 500) {            // number eases from what is shown to the new value
  const from = +el.dataset.v || to, id = (el._tw = (el._tw || 0) + 1); el.dataset.v = to;
  const t0 = performance.now();
  (function step(t) {
    if (el._tw !== id) return;
    const p = Math.min((t - t0) / ms, 1), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

/* ---------- Rendering ---------- */
function playLabel() {
  if (G.stems) return $('stage').classList.contains('playing') ? 'Stop' : 'Play';
  return `Play ${G.stages[round.skips].label}`;
}
function syncPlay() { if (round && !round.over) $('play').textContent = playLabel(); }
function render() {
  const n = round.skips, over = round.over, fin = game.viewFinal, st = G.stages[n], MAX = stageCount();
  const best = store.get(highKey(mode), 0), maxPts = G.start * game.order.length;
  $('game').hidden = over; $('end').hidden = !over || fin; $('final').hidden = !fin;
  const B = G.stems;                            // Bandle swaps the vinyl + segments for the lane mixer
  $('segments').hidden = fin || B; $('stage').hidden = fin || B; $('bandstage').hidden = fin || !B;
  if (B) {
    $('bandstage').classList.toggle('win', over && round.won); $('bandstage').classList.toggle('lose', over && !round.won);
    [...$('lanes').querySelectorAll('.lane')].forEach((l, i) => {
      const on = over || i <= n;
      l.classList.toggle('on', on); l.classList.toggle('next', !over && i === n + 1);
      l.querySelector('small').textContent = over ? 'revealed' : on ? 'in the mix' : i === n + 1 ? `next · −${fmt(G.step)}` : 'locked';
    });
  }
  const showDiff = mode === 'daily' && game.tiered && !fin;      // Daily difficulty bar: Easy, Easy, Medium, Medium, Expert
  $('diffbar').hidden = !showDiff;
  if (showDiff) {
    const cls = ['d-easy', 'd-med', 'd-exp'];
    [...$('diffNames').children].forEach((el, i) => el.classList.toggle('cur', i === levelOf(game.pos)));
    [...$('diffCells').children].forEach((el, k) => { el.className = cls[levelOf(k)] + (k < game.pos ? ' done' : k === game.pos ? ' cur' : ''); });
  }
  $('bigptsBox').hidden = over || fin;          // big "points if you get it now" number, both games
  $('bigcap').textContent = B ? LANE_CAPS[n] : `named on a ${st.label} clip`;
  if (!over && !fin) tweenTo($('bigpts'), worth(round));
  $('recLabel').textContent = over || fin ? '▶' : st.label;
  if ($('scoreNow').textContent !== fmt(total())) { $('scoreNow').textContent = fmt(total()); pulse($('scoreNow'), 'bump'); }
  $('bestNow').textContent = fmt(best);
  const seg = $('segments');
  if (seg.dataset.g !== G.id) { seg.dataset.g = G.id; seg.innerHTML = G.stages.map(s => `<div class="seg">${s.label}</div>`).join(''); }
  [...seg.children].forEach((el, i) => {        // update in place so only changed segments animate
    const cls0 = i < n ? 'skip' : i === n ? (over ? (round.won ? 'correct' : 'wrong') : 'cur') : '';
    const cls = ('seg ' + cls0).trim();
    if (el.className !== cls) el.className = cls;
  });
  const w = $('wrongs');                        // wrong-guess chips: only new ones are appended, so only they animate
  if (w.children.length > round.wrongs.length) w.innerHTML = '';
  while (w.children.length < round.wrongs.length) {
    const c = document.createElement('span'); c.className = 'wchip';
    c.textContent = `${songs[round.wrongs[w.children.length]].title}  −${fmt(G.wrong)}`; w.appendChild(c);
  }
  $('end').classList.toggle('won', over && round.won); $('end').classList.toggle('lost', over && !round.won);
  if (fin) {
    $('status').textContent = `${G.name} · ${mode === 'daily' ? `Daily #${dayNumber() + 1}` : 'Unlimited'}`;
    if (!game.counted) { game.counted = true; countUp($('finalScore'), total(), v => `${fmt(v)} / ${fmt(maxPts)}`, 1400); }
    else $('finalScore').textContent = `${fmt(total())} / ${fmt(maxPts)}`;
    if (game.newBest && !game.celebrated) { game.celebrated = true; burst(); }
    $('finalBest').textContent = game.newBest ? '🏆 New best!' : `Best: ${fmt(best)}`;
    $('finalList').innerHTML = game.order.map((i, k) =>
      `<li style="--n:${k}"><span>${esc(songs[i].title)}<br><small>${esc(songs[i].artist)}</small></span><b>${fmt(game.scores[k])}</b></li>`).join('');
    $('again').hidden = mode === 'daily';
    $('finalNote').textContent = mode === 'daily' ? 'Come back tomorrow for a new round.' : '';
  } else if (over) {
    $('status').textContent = `Song ${game.pos + 1} of ${game.order.length}`;
    $('endTitle').textContent = round.won ? 'Got it!' : 'Missed it';
    if (!round.counted) {                       // first render of this reveal: play the animations once
      round.counted = true;
      countUp($('endPts'), game.scores[game.pos], v => '+' + fmt(v));
      $('stage').classList.add(round.won ? 'win' : 'lose'); pulse($('stage'), 'pop');
      if (round.won) burst();
    } else $('endPts').textContent = '+' + fmt(game.scores[game.pos]);
    $('endSong').textContent = round.song.title; $('endArtist').textContent = round.song.artist;
    $('next').textContent = game.complete ? 'See results' : 'Next song';
  } else {
    const what = `${st.label} clip`;
    $('status').textContent = G.stems ? `Song ${game.pos + 1} of ${game.order.length}` : `Song ${game.pos + 1} of ${game.order.length} · ${what}`;
    $('play').textContent = playLabel();
    $('skip').textContent = n < MAX - 1 ? G.skipLabel : 'Give up';
  }
}
function shareText() {                          // spoiler-free: score + one row per song (one square per stage, ❌ per wrong guess)
  const rows = game.rows.map(r => Array.from({ length: stageCount() }, (_, i) =>
    i < r.skips ? '⬜' : i === r.skips ? (r.won ? '🟩' : '🟥') : '⬛').join('') + (r.wrongs ? ' ' + '❌'.repeat(Math.min(r.wrongs, 5)) : '')).join('\n');
  return `${G.name} ${mode === 'daily' ? '#' + (dayNumber() + 1) : '∞'} ${fmt(total())}/${fmt(G.start * game.order.length)}\n${rows}`;
}
function statsHTML(g, m) {
  const s = store.get(statsKey(m, g), { played: 0, wins: 0, streak: 0, max: 0, dist: Array(g.stages.length).fill(0) });
  const top = Math.max(1, ...s.dist);
  const pct = s.played ? Math.round(100 * s.wins / s.played) : 0;
  return `<h3>${m === 'daily' ? 'Daily' : 'Unlimited'} · best round ${fmt(store.get(highKey(m, g), 0))}</h3><div class="stats">
    <div><b>${s.played}</b><span>Songs</span></div><div><b>${pct}</b><span>Win %</span></div>
    <div><b>${s.streak}</b><span>Streak</span></div><div><b>${s.max}</b><span>Max streak</span></div></div>
    <h3>Guess distribution</h3><div class="dist">${s.dist.map((v, i) =>
      `<span>${i + 1}</span><i class="${v === top && v ? 'hot' : ''}" style="width:${Math.max(8, 100 * v / top)}%">${v}</i>`).join('')}</div>`;
}

/* ---------- Autocomplete ---------- */
let matches = [], hl = -1;
// Normalise for matching: lowercase, drop spaces/punctuation (keeps a-z, 0-9 and Chinese characters).
const norm = t => String(t).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
// Search key = title + artist + their pinyin (full and initials), so "longjuanfeng", "long" or "ljf"
// all find 龙卷风. Uses the pinyin-pro library (loaded from a CDN in index.html); without it, pinyin search is skipped.
function buildKey(s) {
  let key = norm(s.title + s.artist);
  try {                                         // never let a pinyin problem break the game
    if (window.pinyinPro) {
      for (const t of [s.title, s.artist]) {
        const a = pinyinPro.pinyin(String(t), { toneType: 'none', type: 'array', v: true }).filter(x => x.trim());
        key += norm(a.join('')) + norm(a.map(x => x[0]).join(''));
      }
    }
  } catch (e) { console.warn('pinyin failed for', s.title, e); }
  s._key = key;
}
function renderList() {
  const q = $('input').value.trim().toLowerCase();
  const nq = norm(q);
  matches = game.pool.map(i => ({ s: songs[i], i })).filter(({ s }) => !nq || s._key.includes(nq));   // only songs in this game's pool
  hl = matches.length ? 0 : -1;
  $('list').innerHTML = matches.length
    ? matches.map(({ s, i }, k) => `<li role="option" data-i="${i}" class="${k === hl ? 'hl' : ''}">${esc(s.title)}<small>${esc(s.artist)}</small></li>`).join('')
    : '<li class="none">No matching songs</li>';
  $('list').hidden = false; $('input').setAttribute('aria-expanded', 'true');
}
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function closeList() { $('list').hidden = true; $('input').setAttribute('aria-expanded', 'false'); }
function choose(i) { selected = i; $('input').value = `${songs[i].title} — ${songs[i].artist}`; closeList(); }
function moveHl(d) {
  if (!matches.length) return;
  hl = (hl + d + matches.length) % matches.length;
  [...$('list').children].forEach((li, k) => li.classList.toggle('hl', k === hl));
  $('list').children[hl].scrollIntoView({ block: 'nearest' });
}

/* ---------- Events ---------- */
const inPlay = () => !['at-menu', 'at-hub'].some(c => document.body.classList.contains(c));
function bind() {
  $('play').onclick = playClip;
  $('skip').onclick = skip;
  $('sfxBtn').textContent = sfxOn ? '🔊' : '🔇';
  $('sfxBtn').onclick = () => { sfxOn = !sfxOn; store.set('songless.sfx', sfxOn); $('sfxBtn').textContent = sfxOn ? '🔊' : '🔇'; sfx('tick'); };
  $('record').onclick = () => (round.over ? (isPlaying() ? stopAudio() : playFull(round.song)) : playClip());
  // Bandle: tap or drag across the bars to play from that point; the label column toggles play/stop
  const lanes = $('lanes'); let scrubbing = false;
  const track = () => lanes.querySelector('.ph-track').getBoundingClientRect();
  const posAt = x => { const r = track(); return Math.min(Math.max((x - r.left) / r.width, 0), 1) * band.dur; };
  lanes.onpointerdown = e => {
    if (e.clientX < track().left - 4) return $('record').onclick();
    scrubbing = true; lanes.setPointerCapture(e.pointerId);
    stopAudio(); band.pos = posAt(e.clientX); paintPos();
  };
  lanes.onpointermove = e => { if (scrubbing) { band.pos = posAt(e.clientX); paintPos(); } };
  lanes.onpointerup = () => { if (scrubbing) { scrubbing = false; startAt(band.pos); } };
  lanes.onpointercancel = () => { scrubbing = false; };
  lanes.onkeydown = e => { if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); $('record').onclick(); } };
  $('back5').onclick = () => seekBy(-5); $('fwd5').onclick = () => seekBy(5);
  $('submit').onclick = submit;
  $('next').onclick = nextSong;
  $('again').onclick = () => { stopAudio(); sfx('start'); swap(newGame); };
  $('share').onclick = async () => {
    try { await navigator.clipboard.writeText(shareText()); toast('Result copied!'); sfx('tick'); }
    catch { prompt('Copy your result:', shareText()); }
  };
  $('statsBtn').onclick = () => {
    sfx('tick');
    $('statsBody').innerHTML = Object.values(GAMES).map(g => `<h2 class="sg">${g.name}</h2>` + statsHTML(g, 'daily') + statsHTML(g, 'unlimited')).join('');
    $('statsDlg').showModal();
  };
  $('closeStats').onclick = () => { sfx('tick'); $('statsDlg').close(); };
  $('vol').oninput = e => { if (gain) gain.gain.value = +e.target.value; if (el) el.volume = +e.target.value; store.set('songless.vol', +e.target.value); };
  $('vol').value = store.get('songless.vol', 0.8);

  const input = $('input');
  input.oninput = () => { selected = null; renderList(); };   // typing invalidates previous pick
  input.onfocus = renderList;
  input.onblur = () => setTimeout(closeList, 100);
  // mousedown is cancelled so the input keeps focus (otherwise grabbing the list's scrollbar
  // blurs the input and closes the list). Picking happens on click, so scrolling by touch won't pick.
  $('list').addEventListener('mousedown', e => e.preventDefault());
  $('list').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i);
  });
  document.addEventListener('keydown', e => {
    if ($('statsDlg').open || !round || !inPlay()) return;
    if (G.stems && !$('bandstage').hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.target === document.body || e.target === lanes)) {
      e.preventDefault(); seekBy(e.key === 'ArrowLeft' ? -5 : 5); return;     // Bandle: ← / → jump 5 seconds
    }
    if (e.target === input) {
      if (e.key === 'ArrowDown') { e.preventDefault(); $('list').hidden ? renderList() : moveHl(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveHl(-1); }
      else if (e.key === 'Escape') closeList();
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (!$('list').hidden && hl >= 0 && matches[hl]) choose(matches[hl].i);   // first Enter picks
        else submit();                                                            // second Enter submits
      }
    } else if (e.target === document.body && !round.over) {
      if (e.code === 'Space') { e.preventDefault(); playClip(); }
      else if (e.key === 'Enter') submit();
    }
  });
}

/* ---------- Menus ---------- */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
let lang = 'all';                               // 'all' | 'zh' | 'en' (Unlimited only; remembered per game)
let filter = new Set();                         // selected artists; empty = all artists (remembered per game)
let tiers = new Set();                          // selected popularity tiers; empty = all (remembered per game)
let artists = [];                               // artists in the current language: [{name, count, _key}]
// Language: songs.json can set "lang": "zh" | "en" per song. Otherwise a song counts as Chinese if its title
// has Chinese characters, or its artist does (name, or any of that artist's titles, in Chinese characters).
function tagLanguages() {
  const zhArtists = new Set(songs.filter(s => CJK.test(s.title) || CJK.test(s.artist)).map(s => s.artist));
  songs.forEach(s => { s._lang = s.lang === 'zh' || s.lang === 'en' ? s.lang : (CJK.test(s.title) || zhArtists.has(s.artist) ? 'zh' : 'en'); });
}
const inLang = s => lang === 'all' || s._lang === lang;
const tierPass = s => !tiers.size || tiers.has(tierOf(s));      // songs with no rank only show when no tier is picked
const strictPool = () => eligibleIdx().filter(i => inLang(songs[i]) && (!filter.size || filter.has(songs[i].artist)) && tierPass(songs[i]));
const poolIdx = () => {                         // songs Unlimited can pick from (and the guess list)
  const ok = eligibleIdx();
  let p = strictPool();
  if (!p.length) p = ok.filter(i => inLang(songs[i]) && tierPass(songs[i]));
  if (!p.length) p = ok.filter(i => inLang(songs[i]));
  return p.length ? p : ok;
};
function buildArtists() {
  const counts = new Map();
  songs.filter(s => G.eligible(s) && inLang(s)).forEach(s => counts.set(s.artist, (counts.get(s.artist) || 0) + 1));
  artists = [...counts].map(([name, count]) => { const o = { title: '', artist: name }; buildKey(o); return { name, count, _key: o._key }; })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function renderTabs() {
  const base = songs.filter(s => G.eligible(s));
  const n = { all: base.length, zh: base.filter(s => s._lang === 'zh').length, en: base.filter(s => s._lang === 'en').length };
  document.querySelectorAll('.ltab').forEach(b => {
    b.querySelector('small').textContent = n[b.dataset.l];
    b.disabled = n[b.dataset.l] === 0;
    b.classList.toggle('on', b.dataset.l === lang);
  });
}
function renderTiers() {
  const base = songs.filter(s => G.eligible(s) && inLang(s));
  $('tierBox').hidden = !base.some(tierOf);       // hidden until fetch_popularity.py has been run
  document.querySelectorAll('.ttab').forEach(b => {
    const n = base.filter(s => tierOf(s) === b.dataset.t).length;
    b.querySelector('small').textContent = n; b.disabled = n === 0; b.classList.toggle('on', tiers.has(b.dataset.t));
  });
}
function renderChips() {
  const q = norm($('artistSearch').value);
  $('chips').innerHTML = artists.filter(a => !q || a._key.includes(q)).map(a =>
    `<button class="achip${filter.has(a.name) ? ' on' : ''}" data-a="${esc(a.name)}">${esc(a.name)}<small>${a.count}</small></button>`).join('')
    || '<span class="muted">No artists match</span>';
}
function renderInfo() {                         // tile subtitles, best scores, filter summary
  const parts = [`${poolIdx().length} songs`];
  if (lang !== 'all') parts.push(lang === 'zh' ? 'Chinese' : 'English');
  if (filter.size) parts.push(`${filter.size} artist${filter.size > 1 ? 's' : ''}`);
  if (tiers.size) parts.push(TIERS.filter(t => tiers.has(t.id)).map(t => t.label).join(' + '));
  const strict = strictPool().length, w = $('poolWarn');          // honest warning when the filters leave very few songs
  w.hidden = !(strict < SONGS_PER_ROUND && (lang !== 'all' || filter.size || tiers.size));
  w.textContent = strict ? `Only ${strict} song${strict > 1 ? 's' : ''} match these filters, so rounds will be shorter.` : 'No songs match these filters, so all songs in this language are used.';
  $('unlSub').textContent = parts.join(' · ');
  $('filterNote').textContent = filter.size ? `${filter.size} selected` : 'All artists';
  const sv = store.get(dailyKey(), null), t = sv && sv.v === 2 && sv.day === dayNumber() ? sv : null;
  $('dailySub').textContent = !t ? 'New round today' : t.complete ? `Played · ${fmt(t.scores.reduce((x, y) => x + y, 0))} pts`
    : (t.pos || t.skips || t.wrongs.length) ? 'Continue today’s round' : 'New round today';
  $('dailyBest').textContent = 'Best ' + fmt(store.get(highKey('daily'), 0));
  $('unlBest').textContent = 'Best ' + fmt(store.get(highKey('unlimited'), 0));
}
function renderHub() {                          // game tiles: song count and best score
  Object.values(GAMES).forEach(g => {
    const n = songs.filter(s => g.eligible(s)).length;
    const best = Math.max(store.get(highKey('daily', g), 0), store.get(highKey('unlimited', g), 0));
    $('go-' + g.id).disabled = n === 0;
    $('info-' + g.id).textContent = n ? `${n} songs · Best ${fmt(best)}` : 'No stems yet. Run make_stems.py';
  });
}
function saveFilter() { store.set(pk('filter'), [...filter]); store.set(pk('tiers'), [...tiers]); bag = []; renderInfo(); }
function setLang(l) {
  lang = l; store.set(pk('lang'), l); buildArtists();
  const names = new Set(artists.map(a => a.name));
  [...filter].forEach(a => { if (!names.has(a)) filter.delete(a); });   // drop selected artists outside this language
  [...tiers].forEach(t => { if (!songs.some(s => G.eligible(s) && inLang(s) && tierOf(s) === t)) tiers.delete(t); });
  saveFilter(); renderTabs(); renderTiers(); renderChips();
}
function enterGame(id) {                        // select a game and load its own language/artist filter
  G = GAMES[id]; bag = [];
  document.body.classList.toggle('is-bandle', G.stems);
  lang = store.get(pk('lang'), 'all');
  if (!['all', 'zh', 'en'].includes(lang) || !songs.some(s => G.eligible(s) && inLang(s))) lang = 'all';
  buildArtists();
  filter = new Set(store.get(pk('filter'), []).filter(a => artists.some(x => x.name === a)));
  tiers = new Set(store.get(pk('tiers'), []).filter(t => songs.some(s => G.eligible(s) && inLang(s) && tierOf(s) === t)));
  $('menuTitle').textContent = G.name; $('menuBlurb').textContent = G.blurb;
  $('artistSearch').value = '';
  renderTabs(); renderTiers(); renderChips(); renderInfo();
}
function openGame(id) {
  sfx('start');
  swap(() => { enterGame(id); document.body.classList.remove('at-hub'); document.body.classList.add('at-menu'); });
}
function playMode(m) { sfx('start'); swap(() => { document.body.classList.remove('at-menu'); setMode(m); }); }
function confirmLeave() {                       // only an unfinished Unlimited round is lost on leaving
  if (!inPlay()) return true;
  const mid = mode === 'unlimited' && round && game && !game.complete && (game.pos > 0 || round.skips || round.wrongs.length || round.over);
  return !mid || confirm('Leave this round? Your Unlimited progress will be lost.');
}
function showMenu() {                           // back to the current game's Daily/Unlimited menu
  if (!confirmLeave()) return;
  stopAudio(); sfx('back'); swap(() => { document.body.classList.add('at-menu'); renderInfo(); });
}
function showHub() {                            // back to the game picker
  if (!confirmLeave()) return;
  stopAudio(); sfx('back'); swap(() => { document.body.classList.remove('at-menu', 'is-bandle'); document.body.classList.add('at-hub'); renderHub(); });
}
function initMenu() {
  tagLanguages(); assignTiers();
  $('go-songless').onclick = () => openGame('songless');
  $('go-bandle').onclick = () => openGame('bandle');
  $('goDaily').onclick = () => playMode('daily');
  $('goUnl').onclick = () => playMode('unlimited');
  $('backHub').onclick = showHub;
  $('menuBtn').onclick = showMenu;
  $('logo').onclick = () => { if (!document.body.classList.contains('at-hub')) showHub(); };
  $('langTabs').onclick = e => { const b = e.target.closest('.ltab'); if (b && !b.disabled && b.dataset.l !== lang) setLang(b.dataset.l); };
  $('artistSearch').oninput = renderChips;
  $('resetFilter').onclick = () => { filter.clear(); tiers.clear(); lang = 'all'; store.set(pk('lang'), 'all'); buildArtists(); saveFilter(); renderTabs(); renderTiers(); renderChips(); };
  $('tierTabs').onclick = e => {
    const b = e.target.closest('.ttab'); if (!b || b.disabled) return;
    tiers.has(b.dataset.t) ? tiers.delete(b.dataset.t) : tiers.add(b.dataset.t);
    saveFilter(); renderTiers();
  };
  $('chips').onclick = e => {                   // toggle in place so the list keeps its scroll position
    const b = e.target.closest('.achip'); if (!b) return;
    const a = b.dataset.a; filter.has(a) ? filter.delete(a) : filter.add(a);
    b.classList.toggle('on', filter.has(a)); saveFilter();
  };
  enterGame('songless');
  renderHub();
}

/* ---------- Boot ---------- */
(async function init() {
  $('eq').innerHTML = Array.from({ length: 22 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
  buildLanes();
  bind();
  try {
    const r = await fetch('songs.json');
    songs = await r.json();
    if (!Array.isArray(songs) || !songs.length) throw new Error('empty');
  } catch {
    document.body.classList.remove('at-hub');   // the status line is hidden on the picker, so show it
    $('status').textContent = 'Could not load songs.json. Serve the folder over http (see README).';
    $('game').hidden = true; return;
  }
  try {
    songs.forEach(buildKey);
    initMenu();                                 // always start on the game picker
  } catch (e) {                                 // show the real error on the page instead of failing silently
    document.body.classList.remove('at-hub');
    $('status').textContent = 'Error: ' + e.message;
    console.error(e);
  }
})();