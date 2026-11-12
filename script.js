'use strict';
/* ---------- Config ---------- */
const CLIPS = [0.5, 1, 2, 4, 8, 16];          // seconds per attempt; length = number of attempts
const MAX = CLIPS.length;
const EPOCH = Date.UTC(2025, 0, 1);            // Daily #1 = this date (UTC, so everyone matches)

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
let ctx, gain, sfxGain, source = null, playToken = 0;
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
function loadBuffer(song) {                     // fetch + decode once, then cache (preload)
  if (!buffers.has(song.src)) {
    const p = fetch(song.src)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(b => audioCtx().decodeAudioData(b));
    p.catch(() => buffers.delete(song.src));    // allow retry after a failure
    buffers.set(song.src, p);
  }
  return buffers.get(song.src);
}
const RING = 2 * Math.PI * 56;                  // circumference of the progress ring (r = 56)
function setBar(seconds, fraction) {            // sweep the ring over `seconds`; stop = reset
  const ring = $('ring');
  ring.style.transition = 'none'; ring.style.strokeDashoffset = RING;
  $('stage').classList.toggle('playing', !!seconds);
  if (!seconds) return;
  void ring.getBoundingClientRect();            // force reflow so the transition restarts
  ring.style.transition = `stroke-dashoffset ${seconds}s linear`; ring.style.strokeDashoffset = RING * (1 - fraction);
}
function stopAudio() {
  playToken++;
  if (source) { source.onended = null; try { source.stop(); } catch {} source = null; }
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
  setBar(dur, duration ? duration / CLIPS[MAX - 1] : 1);
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
      setBar(duration ?? Math.max(a.duration - offset, 0), duration ? duration / CLIPS[MAX - 1] : 1);
      (function tick() {
        if (token !== playToken) return;
        if (a.currentTime >= end || a.ended) { a.pause(); el = null; setBar(0); return; }
        requestAnimationFrame(tick);
      })();
    }).catch(() => toast(`Couldn't load "${song.src}". Check the path or your connection.`));
  };
  a.readyState >= 1 ? go() : a.addEventListener('loadedmetadata', go, { once: true });
}
const preload = song => loadBuffer(song).catch(() => getEl(song));

/* ---------- State ---------- */
const SONGS_PER_ROUND = 5;                     // one "round" = this many songs
// Scoring: every song starts at START_PTS. Skipping to a longer clip costs SKIP_COST, a wrong guess
// costs WRONG_COST (and does NOT reveal more audio). Reaching 0 points, or giving up, scores 0.
const START_PTS = 10000, SKIP_COST = 1000, WRONG_COST = 500;
const fmt = n => n.toLocaleString('en-US');
let songs = [], mode = 'daily', round = null, game = null, selected = null, bag = [];
const statsKey = m => 'songless.stats.' + m;
const highKey = m => 'songless.high.' + m;     // best round total per mode
const total = () => game.scores.reduce((x, y) => x + y, 0);

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
  preload(song);                                // preload so the 0.5s clip plays instantly
  const nxt = game.order[game.pos + 1]; if (nxt !== undefined) preload(songs[nxt]);
  render();
}
function newGame() {
  const pool = mode === 'daily' ? [...songs.keys()] : poolIdx();   // Unlimited honours the artist filter
  const n = Math.min(SONGS_PER_ROUND, pool.length);
  let order = [];
  if (mode === 'daily') order = seededShuffle(pool, dayNumber() + 1).slice(0, n);
  else {
    bag = bag.filter(i => pool.includes(i));
    while (order.length < n) {                  // no repeats until the whole pool is exhausted
      if (!bag.length) bag = shuffle(pool.filter(i => !order.includes(i)));
      order.push(bag.pop());
    }
  }
  game = { order, pool, pos: 0, rows: [], scores: [], complete: false, viewFinal: false, newBest: false };
  startRound();
}
function setMode(m) {
  stopAudio(); mode = m; store.set('songless.mode', m);
  const sv = m === 'daily' ? store.get('songless.daily', null) : null;
  if (sv && sv.day === dayNumber() && sv.v === 2 && Array.isArray(sv.order) && sv.order.every(i => songs[i])) {
    game = { order: sv.order, pos: sv.pos, rows: sv.rows, scores: sv.scores, complete: sv.complete, viewFinal: sv.complete, newBest: false, pool: [...songs.keys()] };
    startRound(sv);                             // restore today's progress
  } else newGame();
}
function persist() {
  if (mode === 'daily') store.set('songless.daily', { v: 2, day: dayNumber(), order: game.order, pos: game.pos,
    rows: game.rows, scores: game.scores, complete: game.complete, skips: round.skips, wrongs: round.wrongs, over: round.over, won: round.won });
}

/* ---------- Gameplay ---------- */
const worth = r => Math.max(0, START_PTS - SKIP_COST * r.skips - WRONG_COST * r.wrongs.length);
function finish(won) {
  round.over = true; round.won = won;
  game.rows.push({ skips: round.skips, wrongs: round.wrongs.length, won });
  game.scores.push(won ? worth(round) : 0);
  const k = statsKey(mode);                     // per-song stats (distribution = which clip length solved it)
  const s = store.get(k, { played: 0, wins: 0, streak: 0, max: 0, dist: Array(MAX).fill(0) });
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
  const r = round;                              // reveal: after the jingle, play the whole song automatically
  setTimeout(() => { if (round === r && r.over) playSong(r.song); }, 750);
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
  round.wrongs.push(pick);                      // wrong guess: costs points, clip length stays the same
  pulse($('guessbox'), 'shake');
  if (worth(round) <= 0) return finish(false);
  sfx('wrong');
  persist(); render();
}
function skip() {
  if (round.over) return;
  if (round.skips >= MAX - 1) return finish(false);       // already on the longest clip = "Give up"
  round.skips++; sfx('skip');
  persist(); render(); pulse($('stage'), 'pop');
  setTimeout(playClip, 160);                    // let the swish finish so it doesn't cover the start of the clip
}
const playClip = () => playSong(round.song, CLIPS[round.skips]);

/* ---------- Rendering ---------- */
function render() {
  const n = round.skips, over = round.over, fin = game.viewFinal;
  const best = store.get(highKey(mode), 0), maxPts = START_PTS * game.order.length;
  $('game').hidden = over; $('end').hidden = !over || fin; $('final').hidden = !fin;
  $('segments').hidden = fin; $('stage').hidden = fin;
  $('recLabel').textContent = over || fin ? '▶' : CLIPS[n] + 's';
  if ($('scoreNow').textContent !== fmt(total())) { $('scoreNow').textContent = fmt(total()); pulse($('scoreNow'), 'bump'); }
  $('bestNow').textContent = fmt(best);
  if ($('segments').children.length !== MAX) $('segments').innerHTML = CLIPS.map(c => `<div class="seg">${c}s</div>`).join('');
  [...$('segments').children].forEach((el, i) => {   // update in place so only changed segments animate
    const st = i < n ? 'skip' : i === n ? (over ? (round.won ? 'correct' : 'wrong') : 'cur') : '';
    const cls = ('seg ' + st).trim();
    if (el.className !== cls) el.className = cls;
  });
  const w = $('wrongs');                        // wrong-guess chips: only new ones are appended, so only they animate
  if (w.children.length > round.wrongs.length) w.innerHTML = '';
  while (w.children.length < round.wrongs.length) {
    const c = document.createElement('span'); c.className = 'wchip';
    c.textContent = `${songs[round.wrongs[w.children.length]].title}  −${fmt(WRONG_COST)}`; w.appendChild(c);
  }
  $('end').classList.toggle('won', over && round.won); $('end').classList.toggle('lost', over && !round.won);
  if (fin) {
    $('status').textContent = mode === 'daily' ? `Daily #${dayNumber() + 1}` : 'Unlimited';
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
    $('status').textContent = `Song ${game.pos + 1} of ${game.order.length} · ${CLIPS[n]}s clip · worth ${fmt(worth(round))}`;
    $('play').textContent = `Play ${CLIPS[n]}s`;
    $('skip').textContent = n < MAX - 1 ? 'Skip' : 'Give up';
  }
}
function shareText() {                          // spoiler-free: score + one row per song (clip steps, ❌ per wrong guess)
  const rows = game.rows.map(r => Array.from({ length: MAX }, (_, i) =>
    i < r.skips ? '⬜' : i === r.skips ? (r.won ? '🟩' : '🟥') : '⬛').join('') + (r.wrongs ? ' ' + '❌'.repeat(Math.min(r.wrongs, 5)) : '')).join('\n');
  return `Songless ${mode === 'daily' ? '#' + (dayNumber() + 1) : '∞'} ${fmt(total())}/${fmt(START_PTS * game.order.length)}\n${rows}`;
}
function statsHTML(m) {
  const s = store.get(statsKey(m), { played: 0, wins: 0, streak: 0, max: 0, dist: Array(MAX).fill(0) });
  const top = Math.max(1, ...s.dist);
  const pct = s.played ? Math.round(100 * s.wins / s.played) : 0;
  return `<h3>${m === 'daily' ? 'Daily' : 'Unlimited'} · best round ${fmt(store.get(highKey(m), 0))}</h3><div class="stats">
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
function bind() {
  $('play').onclick = playClip;
  $('skip').onclick = skip;
  $('sfxBtn').textContent = sfxOn ? '🔊' : '🔇';
  $('sfxBtn').onclick = () => { sfxOn = !sfxOn; store.set('songless.sfx', sfxOn); $('sfxBtn').textContent = sfxOn ? '🔊' : '🔇'; sfx('tick'); };
  $('record').onclick = () => (round.over ? (source || el ? stopAudio() : playSong(round.song)) : playClip());
  $('submit').onclick = submit;
  $('next').onclick = nextSong;
  $('again').onclick = () => { stopAudio(); sfx('start'); swap(newGame); };
  $('share').onclick = async () => {
    try { await navigator.clipboard.writeText(shareText()); toast('Result copied!'); sfx('tick'); }
    catch { prompt('Copy your result:', shareText()); }
  };
  $('statsBtn').onclick = () => { sfx('tick'); $('statsBody').innerHTML = statsHTML('daily') + statsHTML('unlimited'); $('statsDlg').showModal(); };
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
    if ($('statsDlg').open || !round || document.body.classList.contains('at-menu')) return;
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

/* ---------- Menu ---------- */
let filter = new Set();                         // selected artists for Unlimited; empty = all artists
let artists = [];                               // [{name, count, _key}] sorted by song count
const poolIdx = () => {
  const p = [...songs.keys()].filter(i => !filter.size || filter.has(songs[i].artist));
  return p.length ? p : [...songs.keys()];
};
function renderChips() {
  const q = norm($('artistSearch').value);
  $('chips').innerHTML = artists.filter(a => !q || a._key.includes(q)).map(a =>
    `<button class="achip${filter.has(a.name) ? ' on' : ''}" data-a="${esc(a.name)}">${esc(a.name)}<small>${a.count}</small></button>`).join('')
    || '<span class="muted">No artists match</span>';
}
function renderInfo() {                         // tile subtitles, best scores, filter summary
  const n = poolIdx().length;
  $('unlSub').textContent = filter.size ? `${n} songs · ${filter.size} artist${filter.size > 1 ? 's' : ''}` : `All ${n} songs`;
  $('filterNote').textContent = filter.size ? `${filter.size} selected` : 'All artists';
  const sv = store.get('songless.daily', null), t = sv && sv.v === 2 && sv.day === dayNumber() ? sv : null;
  $('dailySub').textContent = !t ? 'New round today' : t.complete ? `Played · ${fmt(t.scores.reduce((x, y) => x + y, 0))} pts`
    : (t.pos || t.skips || t.wrongs.length) ? 'Continue today’s round' : 'New round today';
  $('dailyBest').textContent = 'Best ' + fmt(store.get(highKey('daily'), 0));
  $('unlBest').textContent = 'Best ' + fmt(store.get(highKey('unlimited'), 0));
}
function saveFilter() { store.set('songless.filter', [...filter]); bag = []; renderInfo(); }
function playMode(m) { sfx('start'); swap(() => { document.body.classList.remove('at-menu'); setMode(m); }); }
function showMenu() {
  const mid = mode === 'unlimited' && round && game && !game.complete && (game.pos > 0 || round.skips || round.wrongs.length || round.over);
  if (mid && !confirm('Leave this round? Your Unlimited progress will be lost.')) return;
  stopAudio(); sfx('back'); swap(() => { document.body.classList.add('at-menu'); renderInfo(); });
}
function initMenu() {
  const counts = new Map();
  songs.forEach(s => counts.set(s.artist, (counts.get(s.artist) || 0) + 1));
  artists = [...counts].map(([name, count]) => { const o = { title: '', artist: name }; buildKey(o); return { name, count, _key: o._key }; })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  filter = new Set(store.get('songless.filter', []).filter(a => counts.has(a)));
  $('goDaily').onclick = () => playMode('daily');
  $('goUnl').onclick = () => playMode('unlimited');
  $('menuBtn').onclick = showMenu;
  $('logo').onclick = () => { if (!document.body.classList.contains('at-menu')) showMenu(); };
  $('artistSearch').oninput = renderChips;
  $('resetFilter').onclick = () => { filter.clear(); saveFilter(); renderChips(); };
  $('chips').onclick = e => {                   // toggle in place so the list keeps its scroll position
    const b = e.target.closest('.achip'); if (!b) return;
    const a = b.dataset.a; filter.has(a) ? filter.delete(a) : filter.add(a);
    b.classList.toggle('on', filter.has(a)); saveFilter();
  };
  renderChips(); renderInfo();
}

/* ---------- Boot ---------- */
(async function init() {
  $('eq').innerHTML = Array.from({ length: 22 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
  bind();
  try {
    const r = await fetch('songs.json');
    songs = await r.json();
    if (!Array.isArray(songs) || !songs.length) throw new Error('empty');
  } catch {
    $('status').textContent = 'Could not load songs.json. Serve the folder over http (see README).';
    $('game').hidden = true; return;
  }
  try {
    songs.forEach(buildKey);
    initMenu();                                 // always start on the menu
  } catch (e) {                                 // show the real error on the page instead of failing silently
    $('status').textContent = 'Error: ' + e.message;
    console.error(e);
  }
})();