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

/* ---------- Audio (Web Audio API) ----------
   AudioBufferSourceNode.start(when, offset, duration) schedules the stop on the audio
   clock, so clips end exactly on time with no bleed (unlike setTimeout + pause()). */
let ctx, gain, source = null, playToken = 0;
const buffers = new Map();                      // src -> Promise<AudioBuffer>
function audioCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    gain = ctx.createGain(); gain.gain.value = +$('vol').value; gain.connect(ctx.destination);
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
function setBar(seconds, fraction) {            // animate progress bar over `seconds`
  const bar = $('bar');
  bar.style.transition = 'none'; bar.style.width = '0';
  if (!seconds) return;
  void bar.offsetWidth;                         // force reflow so the transition restarts
  bar.style.transition = `width ${seconds}s linear`; bar.style.width = fraction * 100 + '%';
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
// Points for a correct guess on attempt 1..6. Skips and wrong guesses both use up an attempt, so the
// longer the clip you needed, the fewer points. A miss scores 0. Keep this the same length as CLIPS.
const SCORES = [10000, 8000, 6000, 4000, 2000, 1000];
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
  round = { idx, song, res: saved?.res || [], over: !!saved?.over, won: !!saved?.won };
  selected = null; $('input').value = '';
  preload(song);                                // preload so the 0.5s clip plays instantly
  const nxt = game.order[game.pos + 1]; if (nxt !== undefined) preload(songs[nxt]);
  render();
}
function newGame() {
  const n = Math.min(SONGS_PER_ROUND, songs.length);
  let order = [];
  if (mode === 'daily') order = seededShuffle([...songs.keys()], dayNumber() + 1).slice(0, n);
  else while (order.length < n) {               // no repeats until the whole list is exhausted
    if (!bag.length) bag = shuffle([...songs.keys()].filter(i => !order.includes(i)));
    order.push(bag.pop());
  }
  game = { order, pos: 0, rows: [], scores: [], complete: false, viewFinal: false, newBest: false };
  startRound();
}
function setMode(m) {
  stopAudio(); mode = m; store.set('songless.mode', m);
  const sv = m === 'daily' ? store.get('songless.daily', null) : null;
  if (sv && sv.day === dayNumber() && Array.isArray(sv.order) && sv.order.every(i => songs[i])) {
    game = { order: sv.order, pos: sv.pos, rows: sv.rows, scores: sv.scores, complete: sv.complete, viewFinal: sv.complete, newBest: false };
    startRound(sv);                             // restore today's progress
  } else newGame();
}
function persist() {
  if (mode === 'daily') store.set('songless.daily', { day: dayNumber(), order: game.order, pos: game.pos,
    rows: game.rows, scores: game.scores, complete: game.complete, res: round.res, over: round.over, won: round.won });
}

/* ---------- Gameplay ---------- */
function finish(won) {
  round.over = true; round.won = won; stopAudio();
  game.rows.push(round.res.slice());
  game.scores.push(won ? SCORES[Math.min(round.res.length, SCORES.length) - 1] : 0);
  const k = statsKey(mode);                     // per-song stats
  const s = store.get(k, { played: 0, wins: 0, streak: 0, max: 0, dist: Array(MAX).fill(0) });
  s.played++;
  if (won) { s.wins++; s.streak++; s.max = Math.max(s.max, s.streak); s.dist[round.res.length - 1]++; }
  else s.streak = 0;
  store.set(k, s);
  if (game.pos === game.order.length - 1) {     // last song: round complete, update high score now
    game.complete = true;
    game.newBest = total() > store.get(highKey(mode), 0);
    if (game.newBest) store.set(highKey(mode), total());
  }
  persist(); render();
}
function nextSong() {
  stopAudio();
  if (game.complete) { game.viewFinal = true; render(); return; }
  game.pos++; startRound(); persist();
}
function submit() {
  if (round.over) return;
  if (selected === null) return toast('Pick a song from the list first.');
  const ok = selected === round.idx;
  round.res.push(ok ? 'correct' : 'wrong');
  selected = null; $('input').value = '';
  if (ok) return finish(true);
  if (round.res.length >= MAX) return finish(false);
  persist(); render(); playClip();
}
function skip() {
  if (round.over) return;
  round.res.push('skip');
  if (round.res.length >= MAX) return finish(false);
  persist(); render(); playClip();
}
const playClip = () => playSong(round.song, CLIPS[Math.min(round.res.length, MAX - 1)]);

/* ---------- Rendering ---------- */
function render() {
  const n = round.res.length, over = round.over, fin = game.viewFinal;
  const best = store.get(highKey(mode), 0), maxPts = SCORES[0] * game.order.length;
  $('modeDaily').classList.toggle('on', mode === 'daily');
  $('modeUnl').classList.toggle('on', mode === 'unlimited');
  $('game').hidden = over; $('end').hidden = !over || fin; $('final').hidden = !fin;
  $('segments').hidden = fin; $('progress').hidden = fin;
  $('scorebar').innerHTML = `<span>Score ${fmt(total())}</span><span>Best ${fmt(best)}</span>`;
  $('segments').innerHTML = CLIPS.map((c, i) => {
    const cls = round.res[i] || (i === n && !over ? 'cur' : '');
    return `<div class="seg ${cls}">${c}s</div>`;
  }).join('');
  if (fin) {
    $('status').textContent = mode === 'daily' ? `Daily #${dayNumber() + 1}` : 'Unlimited';
    $('finalScore').textContent = `${fmt(total())} / ${fmt(maxPts)}`;
    $('finalBest').textContent = game.newBest ? '🏆 New best!' : `Best: ${fmt(best)}`;
    $('finalList').innerHTML = game.order.map((i, k) =>
      `<li><span>${esc(songs[i].title)}<br><small>${esc(songs[i].artist)}</small></span><b>${fmt(game.scores[k])}</b></li>`).join('');
    $('again').hidden = mode === 'daily';
    $('finalNote').textContent = mode === 'daily' ? 'Come back tomorrow for a new round.' : '';
  } else if (over) {
    $('status').textContent = `Song ${game.pos + 1} of ${game.order.length}`;
    $('endTitle').textContent = round.won ? `Got it in ${n}!` : 'Missed it';
    $('endPts').textContent = '+' + fmt(game.scores[game.pos]);
    $('endSong').textContent = round.song.title; $('endArtist').textContent = round.song.artist;
    $('next').textContent = game.complete ? 'See results' : 'Next song';
  } else {
    $('status').textContent = `Song ${game.pos + 1} of ${game.order.length} · Attempt ${n + 1} of ${MAX} · worth ${fmt(SCORES[n])}`;
    $('play').textContent = `Play ${CLIPS[n]}s`;
    $('skip').textContent = n < MAX - 1 ? `Skip (+${CLIPS[n + 1] - CLIPS[n]}s)` : 'Give up';
  }
}
function shareText() {                          // spoiler-free: score + one emoji row per song
  const rows = game.rows.map(r => Array.from({ length: MAX }, (_, i) =>
    ({ correct: '🟩', wrong: '🟥', skip: '⬜' }[r[i]] || '⬛')).join('')).join('\n');
  return `Songless ${mode === 'daily' ? '#' + (dayNumber() + 1) : '∞'} ${fmt(total())}/${fmt(SCORES[0] * game.order.length)}\n${rows}`;
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
  matches = songs.map((s, i) => ({ s, i })).filter(({ s }) => !nq || s._key.includes(nq));
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
  $('submit').onclick = submit;
  $('next').onclick = nextSong;
  $('again').onclick = () => { stopAudio(); newGame(); };
  $('full').onclick = () => (source ? stopAudio() : playSong(round.song));
  $('modeDaily').onclick = () => setMode('daily');
  $('modeUnl').onclick = () => setMode('unlimited');
  $('share').onclick = async () => {
    try { await navigator.clipboard.writeText(shareText()); toast('Result copied!'); }
    catch { prompt('Copy your result:', shareText()); }
  };
  $('statsBtn').onclick = () => { $('statsBody').innerHTML = statsHTML('daily') + statsHTML('unlimited'); $('statsDlg').showModal(); };
  $('closeStats').onclick = () => $('statsDlg').close();
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
    if ($('statsDlg').open || !round) return;
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

/* ---------- Boot ---------- */
(async function init() {
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
    setMode(store.get('songless.mode', 'daily'));
  } catch (e) {                                 // show the real error on the page instead of failing silently
    $('status').textContent = 'Error: ' + e.message;
    console.error(e);
  }
})();