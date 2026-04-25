// ============================================================
// FAMOUS PEOPLE DATASET — loaded from people.xml at boot
// ============================================================
let PEOPLE = [];

async function loadPeople() {
  const res = await fetch('people.xml');
  if (!res.ok) throw new Error('Failed to load people.xml');
  const xmlText = await res.text();
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('people.xml parse error: ' + parseError.textContent);
  return Array.from(doc.querySelectorAll('person')).map(p => ({
    name: p.querySelector('name').textContent,
    wiki: p.querySelector('wiki').textContent,
    category: p.querySelector('category').textContent,
    born:  p.getAttribute('born')  || null,
    died:  p.getAttribute('died')  || null,
    alive: p.getAttribute('alive') === 'true',
  }));
}

// ============================================================
// HINT DEFINITIONS
// ============================================================
const HINT_DEFS = [
  { key: "category",    label: "Occupation",   cost: 150,  extract: d => d.category },
  { key: "nationality", label: "Nationality",      cost: 100,  extract: d => extractNationality(d) },
  { key: "lifespan",    label: "Lifespan",          cost: 75, extract: d => {
    const born = d.born || "?";
    const died = d.died || (d.alive ? "present" : "?");
    return `${born} – ${died}`;
  }},
  { key: "summary",     label: "First sentence on Wikipedia",  cost: 250, extract: d => d.firstSentence || "…" },
];

// ============================================================
// SEED
// ============================================================
let currentSeed = null;
let pwfSeed = null;

function generateSeed() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function deriveNextSeed(seed) {
  const h = hashStr(seed + ':next');
  const s = h.toString(36).toUpperCase();
  return s.length >= 6 ? s.slice(0, 6) : s.padStart(6, '0');
}

function playRandom() {
  startGame(currentSeed ? deriveNextSeed(currentSeed) : null);
}

// ============================================================
// DAILY CHALLENGE
// ============================================================
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function getPSTDateString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

function showDailySplash() {
  document.getElementById('daily-splash-date').textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date());
  const friendScore = new URLSearchParams(window.location.search).get('s');
  const scoreEl = document.getElementById('daily-splash-friend-score');
  if (friendScore) {
    scoreEl.textContent = `A friend scored ${Number(friendScore).toLocaleString()} — can you beat them?`;
    scoreEl.style.display = 'block';
  } else {
    scoreEl.style.display = 'none';
  }
  showScreen('screen-daily');
}

function startDailyChallenge() {
  const dailySeed = getPSTDateString();
  currentSeed = dailySeed;
  const rng = mulberry32(hashStr(dailySeed));
  const pool = PEOPLE;
  const indices = seededShuffle([...Array(pool.length).keys()], rng).slice(0, ROUNDS);
  state = {
    pool,
    queue: indices,
    seed: dailySeed,
    roundIndex: 0,
    roundPoints: START_POINTS,
    totalScore: 0,
    currentPerson: null,
    currentData: null,
    unlockedHints: {},
    wrongGuesses: [],
    results: [],
    isDaily: true,
  };
  document.body.classList.add('in-game');
  showScreen('screen-game');
  document.getElementById('scorebar').classList.add('visible');
  updateGameBadge();
  loadRound();
}

// ============================================================
// GAME STATE
// ============================================================
const ROUNDS = 5;
const START_POINTS = 1000;
const WRONG_PENALTY = 50;

let state = {
  queue: [],          // shuffled indices into PEOPLE
  roundIndex: 0,
  roundPoints: START_POINTS,
  totalScore: 0,
  currentPerson: null,
  currentData: null,
  unlockedHints: {},
  wrongGuesses: [],
  results: [],
};

// ============================================================
// WIKIPEDIA API
// ============================================================
async function fetchWikiData(person) {
  const title = encodeURIComponent(person.wiki);
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;
  try {
    const res = await fetch(summaryUrl);
    if (!res.ok) throw new Error('Not found');
    const json = await res.json();
    const data = {
      name: person.name,
      category: person.category,
      imageUrl: json.thumbnail?.source || json.originalimage?.source || null,
      extract: json.extract || "",
      firstSentence: pickBioSnippet(json.extract || "", person.name, json.extract_html || ""),
      born: null,
      died: null,
      alive: false,
      nationality: null,
    };
    // Parse birth/death from description or extract
    const desc = (json.description || "") + " " + (json.extract || "");
    const bornMatch = desc.match(/born\s+(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+\w+\s+\d{4}|\d{4})/i);
    const diedMatch = desc.match(/died\s+(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+\w+\s+\d{4}|\d{4})/i);
    const yrMatch = desc.match(/(\d{4})[\s\-–](\d{4}|\bpresent\b)/i);
    if (bornMatch) data.born = bornMatch[1];
    else if (yrMatch) data.born = yrMatch[1];
    if (diedMatch) data.died = diedMatch[1];
    else if (yrMatch && yrMatch[2].toLowerCase() !== 'present') data.died = yrMatch[2];
    else if (yrMatch && yrMatch[2].toLowerCase() === 'present') data.alive = true;
    // people.xml overrides take precedence over Wikipedia-parsed values
    if (person.born) data.born = person.born;
    if (person.died) data.died = person.died;
    if (person.alive) data.alive = true;
    data.nationality = extractNationalityFromText(json.extract || json.description || "");
    return data;
  } catch(e) {
    return {
      name: person.name,
      category: person.category,
      imageUrl: null,
      extract: "",
      firstSentence: "No summary available.",
      born: null, died: null, alive: false, nationality: null,
    };
  }
}

function extractNationality(data) {
  return data.nationality || "Unknown";
}

// Pick the first sentence that survives redaction with enough info intact;
// fall back to subsequent sentences if too much of the leading sentence is the
// subject's name (e.g. "Franklin Delano Roosevelt, often referred to by FDR,…").
const REDACTION_LIMIT = 0.4;

function pickBioSnippet(extract, personName, extractHtml) {
  const parts = extract.split(/\. /);
  for (let i = 0; i < Math.min(parts.length, 3); i++) {
    const cleaned = parts[i].replace(/\(.*?\)/g, "").trim();
    if (!cleaned) continue;
    const sentence = cleaned + (cleaned.endsWith('.') ? '' : '.');
    const redacted = redactNames(sentence, personName, extractHtml);
    if (redactionRatio(redacted) <= REDACTION_LIMIT) return redacted;
  }
  const fallback = (parts[0] || "").replace(/\(.*?\)/g, "").trim();
  return redactNames(fallback + (fallback.endsWith('.') ? '' : '.'), personName, extractHtml);
}

function redactionRatio(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const censored = tokens.filter(t => t.includes('█')).length;
  return censored / tokens.length;
}

// Replace every token of the subject's name(s) with a block. Uses Wikipedia's
// <b>…</b> spans to catch birth names, nicknames, aliases not present in our
// stored name (e.g. "Gabrielle Bonheur" / "Coco" for Coco Chanel).
function redactNames(sentence, personName, extractHtml) {
  const tokens = new Set();
  const addTokens = str => {
    str.replace(/<[^>]+>/g, ' ')
       .replace(/[\"'“”‘’„«»]/g, ' ')
       .replace(/\(.*?\)/g, ' ')
       .split(/\s+/)
       .map(t => t.replace(/[,.;:!?]+$/, ''))
       .filter(t => t.length >= 2)
       .forEach(t => tokens.add(t));
  };
  addTokens(personName);
  const boldSpans = [...extractHtml.matchAll(/<b[^>]*>([\s\S]*?)<\/b>/gi)].map(m => m[1]);
  boldSpans.forEach(addTokens);

  let result = sentence;
  const BLOCK = '█████';
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^\\p{L}])' + escaped + '(?=[^\\p{L}]|$)', 'giu');
    result = result.replace(re, (_m, pre) => pre + BLOCK);
  }
  return result;
}

function extractNationalityFromText(text) {
  const nationalities = [
    "American","British","French","German","Italian","Russian","Spanish","Polish",
    "Greek","Roman","Egyptian","Indian","Chinese","Japanese","Brazilian","Argentine",
    "Austrian","Hungarian","Dutch","Swedish","Norwegian","Danish","Swiss","Czech",
    "English","Scottish","Irish","Welsh","Canadian","Australian","South African",
    "Cuban","Jamaican","Bolivian","Mexican","Albanian","Serbian","Croatian",
    "Algerian","Tunisian","Kenyan","Nigerian",
  ];
  for (const nat of nationalities) {
    if (new RegExp('\\b' + nat + '\\b', 'i').test(text)) return nat;
  }
  return null;
}

// ============================================================
// GAME LOGIC
// ============================================================
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function seededShuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGame(seed = null) {
  if (!seed) seed = generateSeed();
  currentSeed = seed;
  const pool = PEOPLE;
  const rng = mulberry32(hashStr(seed));
  const indices = seededShuffle([...Array(pool.length).keys()], rng).slice(0, ROUNDS);
  state = {
    pool,
    queue: indices,
    seed,
    roundIndex: 0,
    roundPoints: START_POINTS,
    totalScore: 0,
    currentPerson: null,
    currentData: null,
    unlockedHints: {},
    wrongGuesses: [],
    results: [],
    isDaily: false,
  };
  document.body.classList.add('in-game');
  showScreen('screen-game');
  document.getElementById('scorebar').classList.add('visible');
  updateGameBadge();
  loadRound();
}

async function loadRound() {
  const personIdx = state.queue[state.roundIndex];
  state.currentPerson = state.pool[personIdx];
  state.roundPoints = START_POINTS;
  state.unlockedHints = {};
  state.wrongGuesses = [];
  state.currentData = null;

  // Reset UI
  document.getElementById('guess-input').value = '';
  document.getElementById('guess-input').className = '';
  document.getElementById('wrong-guesses').textContent = '';
  document.getElementById('autocomplete-list').innerHTML = '';
  document.getElementById('autocomplete-list').classList.remove('open');
  document.getElementById('feedback-overlay').classList.remove('show');
  document.getElementById('person-photo').style.display = 'none';
  document.getElementById('photo-loading').style.display = 'flex';

  updateScorebar();
  renderHints(null);
  document.getElementById('round-badge').textContent = `Round ${state.roundIndex + 1} / ${ROUNDS}`;

  // Fetch wiki data
  const data = await fetchWikiData(state.currentPerson);
  state.currentData = data;

  // Show photo
  const img = document.getElementById('person-photo');
  if (data.imageUrl) {
    img.onload = () => {
      document.getElementById('photo-loading').style.display = 'none';
      img.style.display = 'block';
    };
    img.onerror = () => {
      document.getElementById('photo-loading').textContent = '📷 No image available';
    };
    img.src = data.imageUrl;
  } else {
    document.getElementById('photo-loading').textContent = '📷 No image available';
  }

  renderHints(data);
  document.getElementById('guess-input').focus();
}

function renderHints(data) {
  const grid = document.getElementById('hints-grid');
  grid.innerHTML = '';
  for (const hint of HINT_DEFS) {
    const chip = document.createElement('div');
    const unlocked = !!state.unlockedHints[hint.key];
    const wide = hint.key === 'summary' ? ' hint-chip-wide' : '';
    chip.className = `hint-chip ${unlocked ? 'unlocked' : 'locked'}${wide}`;
    if (unlocked && data) {
      const val = hint.extract(data);
      chip.innerHTML = `<span class="hint-cost">${hint.label}</span><span class="hint-value">${val}</span>`;
    } else {
      chip.innerHTML = `<span class="hint-cost">−${hint.cost} pts</span><span class="hint-value">🔒 ${hint.label}</span>`;
      chip.onclick = () => unlockHint(hint);
    }
    grid.appendChild(chip);
  }
}

function unlockHint(hint) {
  if (state.unlockedHints[hint.key]) return;
  if (state.roundPoints <= 0) { alert("No points left to spend!"); return; }
  state.roundPoints = Math.max(0, state.roundPoints - hint.cost);
  state.unlockedHints[hint.key] = true;
  updateScorebar();
  renderHints(state.currentData);
}

function submitGuess() {
  const input = document.getElementById('guess-input');
  const val = input.value.trim();
  if (!val) return;

  const correct = val.toLowerCase() === state.currentPerson.name.toLowerCase();
  if (correct) {
    handleCorrect();
  } else {
    state.wrongGuesses.push(val);
    state.roundPoints = Math.max(0, state.roundPoints - WRONG_PENALTY);
    updateScorebar();
    input.classList.add('wrong');
    setTimeout(() => input.classList.remove('wrong'), 400);
    input.value = '';
    closeAutocomplete();
    document.getElementById('wrong-guesses').textContent =
      '✗ ' + state.wrongGuesses.slice(-3).join('  •  ✗ ');
    if (state.roundPoints === 0) {
      showFeedback(false);
    }
  }
}

function handleCorrect() {
  state.totalScore += state.roundPoints;
  state.results.push({
    name: state.currentPerson.name,
    correct: true,
    points: state.roundPoints,
    guesses: state.wrongGuesses.length + 1,
    hintsUsed: Object.keys(state.unlockedHints).length,
  });
  showFeedback(true);
}

function skipRound() {
  state.results.push({
    name: state.currentPerson.name,
    correct: false,
    points: 0,
    guesses: state.wrongGuesses.length,
    hintsUsed: Object.keys(state.unlockedHints).length,
    skipped: true,
  });
  state.roundPoints = 0;
  showFeedback(false, true);
}

let feedbackShownAt = 0;

function showFeedback(correct, skipped = false) {
  feedbackShownAt = Date.now();
  const overlay = document.getElementById('feedback-overlay');
  overlay.classList.add('show');
  document.getElementById('feedback-emoji').textContent = correct ? '🎉' : (skipped ? '⏭' : '😅');
  const ft = document.getElementById('feedback-text');
  ft.textContent = correct ? 'Correct!' : (skipped ? 'Skipped!' : 'Out of points!');
  ft.className = `feedback-text ${correct ? 'correct' : 'wrong'}`;
  document.getElementById('feedback-name').textContent = `It was: ${state.currentPerson.name}`;
  overlay.querySelector('button').focus();
}

function nextRound() {
  const overlay = document.getElementById('feedback-overlay');
  if (!overlay.classList.contains('show')) return;
  overlay.classList.remove('show');
  state.roundIndex++;
  if (state.roundIndex >= ROUNDS) {
    endGame();
  } else {
    loadRound();
  }
}

function endGame() {
  document.body.classList.remove('in-game');
  document.getElementById('scorebar').classList.remove('visible');
  showScreen('screen-end');

  document.getElementById('end-score').textContent = state.totalScore;
  const badge = document.getElementById('end-mode-badge');
  if (state.isDaily) {
    badge.textContent = '⭐ Daily';
    badge.style.color = '#E6B800';
    badge.style.borderColor = '#E6B800';
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
  const maxPossible = ROUNDS * START_POINTS;
  const pct = state.totalScore / maxPossible;
  const grades = [
    [0.9, '🌟 Legendary!'],
    [0.7, '🔥 Outstanding!'],
    [0.5, '👍 Not Bad!'],
    [0.3, '😬 Keep Practicing'],
    [0,   '💀 Yikes…'],
  ];
  document.getElementById('end-grade').textContent = (grades.find(g => pct >= g[0]) || grades[4])[1];

  // Build results list
  const list = document.getElementById('results-list');
  list.innerHTML = '';
  for (const r of state.results) {
    const div = document.createElement('div');
    div.className = `result-row ${r.correct ? 'r-correct' : 'r-wrong'}`;
    div.innerHTML = `<div class="r-name">${r.correct ? '✅' : (r.skipped ? '⏭' : '❌')} ${r.name}</div>
      <div class="r-detail">${r.correct ? `+${r.points} pts` : '0 pts'} &nbsp;|&nbsp; ${r.guesses} guess${r.guesses !== 1 ? 'es' : ''} &nbsp;|&nbsp; ${r.hintsUsed} hint${r.hintsUsed !== 1 ? 's' : ''} used</div>`;
    list.appendChild(div);
  }

  // Share URL — stashed on the copy button
  const shareData = buildShareData();
  const shareUrl = window.location.origin + window.location.pathname + '?r=' + shareData;
  document.getElementById('share-copy-btn').dataset.url = shareUrl;

  // Daily challenge share
  document.getElementById('end-daily-share').style.display = state.isDaily ? 'block' : 'none';
}

// ============================================================
// PLAY WITH FRIENDS MODAL
// ============================================================
function openPwfModal() {
  pwfSeed = generateSeed();
  updatePwfLink();
  document.getElementById('pwf-modal').style.display = 'flex';
}

function closePwfModal() {
  document.getElementById('pwf-modal').style.display = 'none';
}

function updatePwfLink() {
  const base = window.location.href.replace(/[?#].*$/, '');
  document.getElementById('pwf-link-input').value = `${base}?seed=${pwfSeed}`;
}

function copyPwfLink(btn) {
  const url = document.getElementById('pwf-link-input').value;
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

function startPwfGame() {
  closePwfModal();
  startGame(pwfSeed);
}

function startSeededGameFromRecap(seed) {
  startGame(seed);
}

function copyDailyUrl(btn) {
  const base = window.location.href.replace(/[?#].*$/, '');
  navigator.clipboard.writeText(`${base}?daily=1&s=${state.totalScore}`).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✅ Link copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

function buildShareData() {
  const payload = {
    s: state.totalScore,
    dy: state.isDaily ? 1 : 0,
    seed: state.isDaily ? null : (state.seed || null),
    r: state.results.map(r => ({
      n: r.name,
      c: r.correct ? 1 : 0,
      p: r.points,
      g: r.guesses,
      h: r.hintsUsed,
      sk: r.skipped ? 1 : 0,
    }))
  };
  return btoa(JSON.stringify(payload));
}

function copyShareUrl() {
  const btn = document.getElementById('share-copy-btn');
  const url = btn.dataset.url;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

// ============================================================
// RECAP (shared URL)
// ============================================================
function checkSharedResult() {
  const params = new URLSearchParams(window.location.search);
  const r = params.get('r');
  if (!r) return false;
  try {
    const data = JSON.parse(atob(r));
    renderRecap(data);
    return true;
  } catch(e) { return false; }
}

function revealRecapAnswers() {
  const results = document.getElementById('recap-results');
  const overlay = document.getElementById('recap-reveal-overlay');
  if (results) { results.style.filter = 'none'; results.style.pointerEvents = 'auto'; }
  if (overlay) overlay.style.display = 'none';
}

function renderRecap(data) {
  showScreen('screen-recap');
  const body = document.getElementById('recap-body');
  const pct = data.s / (ROUNDS * START_POINTS);
  const grades = [[0.9,'🌟 Legendary!'],[0.7,'🔥 Outstanding!'],[0.5,'👍 Not Bad!'],[0.3,'😬 Keep Practicing'],[0,'💀 Yikes…']];
  const grade = (grades.find(g => pct >= g[0]) || grades[4])[1];
  const isRecapDaily = data.dy === 1;

  let resultsHtml = '';
  for (const r of data.r) {
    resultsHtml += `<div class="result-row ${r.c ? 'r-correct' : 'r-wrong'}">
      <div class="r-name">${r.c ? '✅' : (r.sk ? '⏭' : '❌')} ${r.n}</div>
      <div class="r-detail">${r.c ? `+${r.p} pts` : '0 pts'} &nbsp;|&nbsp; ${r.g} guess${r.g!==1?'es':''} &nbsp;|&nbsp; ${r.h} hint${r.h!==1?'s':''}</div>
    </div>`;
  }

  const recapSeed = data.seed || null;
  const playAction = isRecapDaily
    ? 'startDailyChallenge()'
    : (recapSeed ? `startSeededGameFromRecap('${recapSeed}')` : `startGame()`);
  const playLabel = isRecapDaily ? 'Play the Daily &amp; Beat Their Score!' : 'Play &amp; Beat Their Score!';
  const dailyBadgeHtml = isRecapDaily
    ? `<div style="display:inline-block;margin-top:8px;font-family:'Barlow Condensed',sans-serif;font-size:0.78rem;font-weight:700;letter-spacing:3px;text-transform:uppercase;padding:3px 10px;border-radius:3px;border:2px solid #E6B800;color:#E6B800;">⭐ Daily</div>`
    : '';

  body.innerHTML = `
    <div style="text-align:center;margin-bottom:20px;">
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:0.8rem;letter-spacing:4px;color:var(--blue);text-transform:uppercase;margin-bottom:6px;">A friend scored</div>
      <div style="font-family:'Alfa Slab One',serif;font-size:3.5rem;color:var(--text-dark);line-height:1;">${data.s}</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;color:var(--red);font-weight:700;">${grade}</div>
      ${dailyBadgeHtml}
    </div>

    <div style="position:relative;margin-bottom:16px;">
      <div id="recap-results" style="display:flex;flex-direction:column;gap:8px;filter:blur(6px);pointer-events:none;user-select:none;">
        ${resultsHtml}
      </div>
      <div id="recap-reveal-overlay" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
        <button class="btn btn-blue btn-sm" onclick="revealRecapAnswers()">👁 Reveal Answers</button>
      </div>
    </div>

    <div style="text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:0.85rem;letter-spacing:3px;color:#999;text-transform:uppercase;margin-bottom:14px;">— or —</div>
    <div style="text-align:center;">
      <button class="btn btn-gold" style="width:100%;" onclick="${playAction}">▶ ${playLabel}</button>
    </div>`;
}

// ============================================================
// UI HELPERS
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function goHome() {
  currentSeed = null;
  history.replaceState(null, '', window.location.pathname);
  document.body.classList.remove('in-game');
  document.getElementById('scorebar').classList.remove('visible');
  showScreen('screen-welcome');
}

function updateScorebar() {
  document.getElementById('sb-round').textContent = state.roundIndex + 1;
  document.getElementById('sb-pts').textContent = state.roundPoints;
  document.getElementById('sb-total').textContent = state.totalScore;
}

function updateGameBadge() {
  const badge = document.getElementById('game-mode-badge');
  const item = badge ? badge.closest('.score-item') : null;
  if (!badge || !item) return;
  if (state.isDaily) {
    badge.textContent = '⭐ Daily';
    badge.style.color = '#E6B800';
    item.style.display = '';
  } else {
    item.style.display = 'none';
  }
}

// ============================================================
// AUTOCOMPLETE
// ============================================================
const guessInput = document.getElementById('guess-input');
const acList = document.getElementById('autocomplete-list');
let acSelected = -1;

guessInput.addEventListener('input', () => {
  const val = guessInput.value.trim().toLowerCase();
  acSelected = -1;
  if (!val || val.length < 2) { closeAutocomplete(); return; }
  const matches = (state.pool || PEOPLE).map(p => p.name).filter(n => n.toLowerCase().includes(val)).slice(0, 8);
  if (!matches.length) { closeAutocomplete(); return; }
  acList.innerHTML = matches.map((m, i) => {
    const re = new RegExp(`(${val.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
    const highlighted = m.replace(re, '<mark>$1</mark>');
    return `<div class="ac-item" data-name="${m}" data-idx="${i}">${highlighted}</div>`;
  }).join('');
  acList.classList.add('open');
  acList.querySelectorAll('.ac-item').forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      guessInput.value = item.dataset.name;
      closeAutocomplete();
      submitGuess();
    });
  });
});

guessInput.addEventListener('keydown', e => {
  const items = acList.querySelectorAll('.ac-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acSelected = Math.min(acSelected + 1, items.length - 1);
    items.forEach((it, i) => it.classList.toggle('selected', i === acSelected));
    if (items[acSelected]) guessInput.value = items[acSelected].dataset.name;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acSelected = Math.max(acSelected - 1, -1);
    items.forEach((it, i) => it.classList.toggle('selected', i === acSelected));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (acSelected === -1 && items.length === 1) {
      guessInput.value = items[0].dataset.name;
    } else if (acSelected >= 0 && items[acSelected]) {
      guessInput.value = items[acSelected].dataset.name;
    }
    closeAutocomplete();
    submitGuess();
  } else if (e.key === 'Escape') {
    closeAutocomplete();
  }
});

document.addEventListener('click', e => {
  if (!e.target.closest('.guess-area')) closeAutocomplete();
});

document.addEventListener('keydown', () => {
  if (document.getElementById('feedback-overlay').classList.contains('show')
      && Date.now() - feedbackShownAt > 400) {
    nextRound();
  }
});

function closeAutocomplete() {
  acList.innerHTML = '';
  acList.classList.remove('open');
  acSelected = -1;
}

// ============================================================
// BOOT
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  try {
    PEOPLE = await loadPeople();
  } catch (e) {
    console.error(e);
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="background:#E63946;color:#fff;padding:12px;text-align:center;font-family:sans-serif;">Failed to load people.xml — serve this site over HTTP (e.g. <code>python3 -m http.server</code>) rather than opening the file directly.</div>');
    return;
  }
  document.getElementById('daily-date').textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date());
  const params = new URLSearchParams(window.location.search);
  if (params.get('daily') === '1') {
    showDailySplash();
  } else if (params.get('seed')) {
    startGame(params.get('seed'));
  } else if (!checkSharedResult()) {
    showScreen('screen-welcome');
  }
});
