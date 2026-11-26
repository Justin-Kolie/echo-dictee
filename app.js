/* ============================================================
   Écho — Dictée vocale (PWA)
   Reconnaissance vocale : Web Speech API (Chrome, Edge, Safari)
   Traduction : API Translator intégrée (Chrome) sinon MyMemory
   Lecture : synthèse vocale du système (speechSynthesis)
   ============================================================ */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem('echo_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('echo_' + k, JSON.stringify(v)); } catch { /* stockage plein ou bloqué */ } },
};

// ---------------------------------------------------------------- Réglages
const DEFAULTS = {
  base: 'fr', fr: 'fr-FR', en: 'en-US', translate: false, autoSpeak: false, commands: true, autoCap: true,
  wake: true, voiceFr: '', voiceEn: '', rate: 1, size: 20, theme: 'auto', bubble: true, bubblePos: null,
};
const S = Object.assign({}, DEFAULTS, store.get('settings', {}));
const saveSettings = () => store.set('settings', S);
const other = (b) => (b === 'fr' ? 'en' : 'fr');
const LANG_NAME = { fr: 'Français', en: 'Anglais' };

// ---------------------------------------------------------------- Plateforme
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// ---------------------------------------------------------------- État
const st = {
  text: '',            // texte validé (modifiable)
  sessFinal: '',       // résultats définitifs de la session de reconnaissance en cours
  sessInterim: '',     // résultats provisoires
  want: false,         // l'utilisateur veut dicter
  listening: false,
  pausedForTTS: false,
  startedAt: 0, elapsed: 0,
  noteId: null,
  translation: '',
  sessTranslated: 0,   // nombre de caractères bruts déjà traduits dans la session
  errors: [],
};

// ---------------------------------------------------------------- Éléments
const editor = $('#editor'), statusEl = $('#status'), statusText = $('#statusText'), counts = $('#counts');
const trCard = $('#trCard'), trText = $('#trText'), trState = $('#trState');
const bubble = $('#bubble'), bubbleCap = $('#bubbleCap'), quick = $('#quick');

// ================================================================ Mise en forme du texte
const CMD = {
  fr: [
    [/\b(?:nouveau|nouvel) paragraphe\b/gi, '\n\n'], [/\b(?:à la ligne|a la ligne|nouvelle ligne|retour à la ligne)\b/gi, '\n'],
    [/\bpoints? d'interrogation\b/gi, '?'], [/\bpoints? d'exclamation\b/gi, '!'], [/\bpoints de suspension\b/gi, '…'],
    [/\bpoint[- ]virgule\b/gi, ';'], [/\bdeux[- ]points\b/gi, ':'], [/\bvirgule\b/gi, ','],
    [/\b(?:ouvre[rz]? les guillemets|ouvrez les guillemets)\b/gi, '«'], [/\b(?:ferme[rz]? les guillemets|fermez les guillemets)\b/gi, '»'],
    [/\b(?:ouvre[rz]? la parenthèse|ouvrir la parenthèse)\b/gi, '('], [/\b(?:ferme[rz]? la parenthèse|fermer la parenthèse)\b/gi, ')'],
    [/\bpoint final\b/gi, '.'], [/\bpoint\s*$/i, '.'], [/\bpoint (?=à la ligne|\n)/gi, '.'],
  ],
  en: [
    [/\bnew paragraph\b/gi, '\n\n'], [/\bnew line\b/gi, '\n'], [/\bquestion mark\b/gi, '?'], [/\bexclamation (?:mark|point)\b/gi, '!'],
    [/\bsemicolon\b/gi, ';'], [/\bcolon\b/gi, ':'], [/\bcomma\b/gi, ','], [/\bellipsis\b/gi, '…'],
    [/\b(?:open quote|quote)\b/gi, '“'], [/\b(?:close quote|end quote|unquote)\b/gi, '”'],
    [/\bopen (?:parenthesis|bracket)\b/gi, '('], [/\bclose (?:parenthesis|bracket)\b/gi, ')'],
    [/\bfull stop\b/gi, '.'], [/\bperiod\s*$/i, '.'], [/\bperiod (?=new line|\n)/gi, '.'],
  ],
};

function tidy(s, base) {
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/ +([,.…)])/g, '$1').replace(/([(«“]) +/g, '$1');
  if (base === 'fr') {
    s = s.replace(/ *([?!;:»])/g, ' $1').replace(/« */g, '« ');
  } else {
    s = s.replace(/ +([?!;:”])/g, '$1');
  }
  s = s.replace(/([,;:])(?=[^\s\n\d])/g, '$1 ').replace(/([.?!…])(?=[A-Za-zÀ-ÿ])/g, '$1 ');
  return s;
}

/** Transforme un morceau dicté : commandes vocales, ponctuation, majuscules */
function processChunk(raw, before, base = S.base) {
  let s = ' ' + raw.trim() + ' ';
  if (!raw.trim()) return '';
  if (S.commands) for (const [re, rep] of CMD[base]) s = s.replace(re, rep);
  s = tidy(s, base).trim();
  if (S.autoCap) {
    const prev = before.replace(/\s+$/, '');
    const startSentence = !prev || /[.?!…]["”»)]?$/.test(prev) || /\n\s*$/.test(before);
    if (startSentence) s = s.replace(/^([^A-Za-zÀ-ÿ]*)([a-zà-ÿ])/, (m, a, b) => a + b.toUpperCase());
    s = s.replace(/([.?!…]\s+|\n)([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
    if (base === 'en') s = s.replace(/\bi\b/g, 'I').replace(/\bi'(m|ve|ll|d)\b/g, "I'$1");
  }
  return s;
}

/** Concatène proprement deux morceaux de texte */
function join(a, b) {
  if (!b) return a;
  if (!a) return b.replace(/^\s+/, '');
  if (/^[,.;:?!…)»”]/.test(b) && S.base === 'en') return a.replace(/\s+$/, '') + b;
  if (/^[,.…)]/.test(b)) return a.replace(/\s+$/, '') + b;
  if (/^\s?[?!;:»]/.test(b) && S.base === 'fr') return a.replace(/\s+$/, '') + ' ' + b.trim();
  if (/\n$/.test(a) || /^\n/.test(b)) return a + b;
  return a.replace(/\s+$/, '') + ' ' + b;
}

const liveText = () => join(st.text, processChunk(st.sessFinal, st.text));
const wordsOf = (t) => (t.trim() ? t.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0);

// ================================================================ Rendu
function render() {
  const fin = liveText();
  if (st.listening || st.sessFinal || st.sessInterim) {
    const interim = st.sessInterim.trim();
    const sep = interim && fin && !/\s$/.test(fin) ? ' ' : '';
    editor.innerHTML = esc(fin) + (interim ? `<span class="int">${esc(sep + interim)}</span>` : '');
    editor.scrollTop = editor.scrollHeight;
  }
  const n = wordsOf(fin + ' ' + st.sessInterim);
  counts.textContent = `${n} mot${n > 1 ? 's' : ''}`;
  renderStatus();
  renderCaptions();
  renderBubbleCap();
}

function renderStatus() {
  statusEl.classList.toggle('live', st.listening);
  if (st.listening) {
    const s = Math.floor((st.elapsed + (Date.now() - st.startedAt)) / 1000);
    statusText.textContent = `À l'écoute · ${LANG_NAME[S.base]} · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  } else if (st.pausedForTTS) statusText.textContent = 'Lecture de la traduction…';
  else statusText.textContent = st.text ? 'En pause — vous pouvez modifier le texte' : 'Prêt';
}
setInterval(() => { if (st.listening) renderStatus(); }, 500);

function setEditorFromText() {
  editor.textContent = st.text;
  const n = wordsOf(st.text);
  counts.textContent = `${n} mot${n > 1 ? 's' : ''}`;
}

editor.addEventListener('input', () => {
  if (st.listening) return;
  st.text = editor.innerText.replace(/ /g, ' ').replace(/\n$/, '');
  const n = wordsOf(st.text);
  counts.textContent = `${n} mot${n > 1 ? 's' : ''}`;
  scheduleSave();
  if (S.translate) scheduleFullTranslate();
});

// ================================================================ Reconnaissance vocale
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function merge(acc, t) {
  if (!acc) return t;
  const a = norm(acc), b = norm(t);
  if (b.startsWith(a)) return t;          // résultat cumulé
  if (a.endsWith(b)) return acc;          // répétition
  return acc + ' ' + t;
}
let rec = null, restartTimer = null, wakeLock = null, recentRestarts = [];

function makeRec() {
  const r = new SR();
  r.lang = S[S.base];
  r.interimResults = true;
  r.maxAlternatives = 1;
  // Android répète les résultats en mode continu : on redémarre plutôt après chaque phrase
  r.continuous = !isAndroid;
  r.onstart = () => { st.listening = true; document.body.classList.add('listening'); editor.contentEditable = 'false'; render(); };
  r.onresult = (e) => {
    let fin = '', int = '';
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.trim();
      if (!t) continue;
      if (e.results[i].isFinal) fin = merge(fin, t); else int = merge(int, t);
    }
    // Certains navigateurs mobiles renvoient le texte cumulé : on évite les doublons
    if (fin && int && norm(int).startsWith(norm(fin))) int = int.slice(fin.length).trim();
    st.sessFinal = fin; st.sessInterim = int;
    render();
    if (S.translate && fin.length > st.sessTranslated) scheduleLiveTranslate();
  };
  r.onerror = (e) => {
    const err = e.error;
    if (err === 'no-speech' || err === 'aborted') return;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      st.want = false;
      notice(isIOS && isStandalone
        ? '<b>Micro indisponible dans l\'appli installée.</b> Ouvrez Écho dans Safari, ou touchez la zone de texte puis le micro 🎤 du clavier pour dicter.'
        : '<b>Accès au micro refusé.</b> Autorisez le micro pour ce site dans les réglages du navigateur, puis réessayez.', 'warn');
    } else if (err === 'audio-capture') {
      st.want = false; notice('<b>Aucun micro détecté.</b> Vérifiez qu\'un micro est branché et autorisé.', 'warn');
    } else if (err === 'network') {
      notice('<b>Connexion requise.</b> La reconnaissance vocale de ce navigateur fonctionne en ligne.', 'warn');
      st.want = false;
    } else if (err === 'language-not-supported') {
      st.want = false; notice('Cette langue n\'est pas prise en charge par la reconnaissance vocale de votre appareil.', 'warn');
    }
  };
  r.onend = () => {
    commitSession();
    st.listening = false;
    if (st.pausedForTTS) { renderStatus(); return; }
    if (st.want) {
      const now = Date.now();
      recentRestarts = recentRestarts.filter((t) => now - t < 4000);
      recentRestarts.push(now);
      if (recentRestarts.length > 8) { stopListening(); toast('La dictée s\'est arrêtée. Touchez le micro pour reprendre.'); return; }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => { try { rec.lang = S[S.base]; rec.start(); } catch { stopListening(); } }, isAndroid ? 60 : 150);
    } else {
      finishListening();
    }
  };
  return r;
}

function commitSession() {
  const raw = [st.sessFinal, st.sessInterim].filter(Boolean).join(' ');
  const rest = raw.slice(st.sessTranslated);
  if (raw.trim()) st.text = join(st.text, processChunk(raw, st.text));
  if (S.translate && rest.trim()) translateDelta(rest);
  st.sessFinal = ''; st.sessInterim = ''; st.sessTranslated = 0;
  render();
  scheduleSave();
}

async function startListening() {
  if (!SR) {
    editor.focus();
    notice(isIOS
      ? 'Touchez la zone de texte puis la touche <b>micro 🎤 du clavier</b> pour dicter.'
      : '<b>La dictée en direct n\'est pas disponible dans ce navigateur.</b> Utilisez Chrome, Edge ou Safari.', 'warn');
    return;
  }
  if (st.want) return;
  speechSynthesis.cancel();
  st.want = true; st.pausedForTTS = false; recentRestarts = [];
  st.startedAt = Date.now();
  if (!st.noteId) st.noteId = 'n' + Date.now().toString(36);
  if (!rec) rec = makeRec();
  rec.lang = S[S.base];
  document.body.classList.add('listening');
  $('#micBtn').setAttribute('aria-pressed', 'true');
  $('#micBtn').setAttribute('aria-label', 'Arrêter la dictée');
  try { rec.start(); } catch (e) { /* déjà démarrée */ }
  haptic();
  if (S.wake && 'wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* refusé */ } }
  hideNotice();
}

function stopListening() {
  st.want = false; st.pausedForTTS = false;
  clearTimeout(restartTimer);
  if (rec) { try { rec.stop(); } catch { /* */ } }
  if (!st.listening) finishListening();
  haptic();
}

function finishListening() {
  if (st.startedAt) st.elapsed += Date.now() - st.startedAt;
  st.startedAt = 0;
  st.listening = false;
  document.body.classList.remove('listening');
  editor.contentEditable = 'true';
  $('#micBtn').setAttribute('aria-pressed', 'false');
  $('#micBtn').setAttribute('aria-label', 'Démarrer la dictée');
  setEditorFromText();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  render();
  scheduleSave();
}

const toggleListening = () => (st.want ? stopListening() : startListening());

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && st.want && S.wake && 'wakeLock' in navigator && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* */ }
  }
});

// ================================================================ Langue
function setBase(b, { restart = true } = {}) {
  if (b === S.base) return;
  const was = st.want;
  if (was) { st.pausedForTTS = true; try { rec.abort(); } catch { /* */ } }
  S.base = b; saveSettings();
  syncLangUI();
  if (S.translate) { trText.textContent = ''; st.translation = ''; scheduleFullTranslate(0); }
  if (was && restart) setTimeout(() => {
    if (st.startedAt) st.elapsed += Date.now() - st.startedAt;
    st.pausedForTTS = false; st.want = false; startListening();
  }, 250);
}
function syncLangUI() {
  $$('.seg [data-lang]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === S.base)));
  $('#bubbleLang').textContent = S.base.toUpperCase();
  $('#qLang').textContent = other(S.base).toUpperCase();
  $('#capBadge').textContent = S.translate ? `${S.base.toUpperCase()} → ${other(S.base).toUpperCase()}` : S.base.toUpperCase();
  $('#trTitle').textContent = LANG_NAME[other(S.base)];
  $('#trLabel').textContent = S.translate ? `→ ${other(S.base).toUpperCase()}` : 'Traduire';
  $('#trToggle').setAttribute('aria-pressed', String(S.translate));
  trCard.hidden = !S.translate;
  document.documentElement.lang = S.base;
  editor.setAttribute('lang', S[S.base]);
}

// ================================================================ Traduction
const translators = {};
async function translateText(text, from, to) {
  if (!text.trim()) return '';
  // 1) Traducteur intégré au navigateur (Chrome récent, hors ligne)
  try {
    if ('Translator' in self) {
      const key = from + to;
      if (translators[key] === undefined) {
        translators[key] = null;
        const av = await withTimeout(self.Translator.availability({ sourceLanguage: from, targetLanguage: to }), 1500);
        if (av === 'available') translators[key] = await withTimeout(self.Translator.create({ sourceLanguage: from, targetLanguage: to }), 3000);
      }
      if (translators[key]) return await withTimeout(translators[key].translate(text), 6000);
    }
  } catch { /* on passe au service en ligne */ }
  // 2) Service en ligne MyMemory (gratuit, sans compte), par paragraphes et morceaux de 450 caractères
  const paras = text.split('\n');
  const out = [];
  for (const p of paras) {
    if (!p.trim()) { out.push(p); continue; }
    const parts = p.match(/[^.!?…]+[.!?…]*\s*/g) || [p];
    const chunks = [];
    let cur = '';
    for (const s of parts) { if ((cur + s).length > 450 && cur) { chunks.push(cur); cur = ''; } cur += s; }
    if (cur) chunks.push(cur);
    const res = [];
    for (const c of chunks) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(c.trim())}&langpair=${from}|${to}`;
      const r = await fetch(url);
      if (r.status === 429) throw new Error('Limite quotidienne de traduction gratuite atteinte. Réessayez demain.');
      if (!r.ok) throw new Error('Service de traduction indisponible.');
      const j = await r.json();
      const code = Number(j.responseStatus);
      if (code && code !== 200) throw new Error(code === 429 ? 'Limite quotidienne de traduction gratuite atteinte.' : 'Traduction impossible pour le moment.');
      res.push(decodeEntities(j.responseData.translatedText || ''));
    }
    out.push(res.join(' '));
  }
  return out.join('\n');
}
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }

let fullTimer = null, liveTimer = null, trJob = 0;
function scheduleFullTranslate(delay = 900) {
  clearTimeout(fullTimer);
  fullTimer = setTimeout(translateAll, delay);
}
async function translateAll() {
  const job = ++trJob;
  const src = liveText();
  if (!src.trim()) { trText.textContent = ''; st.translation = ''; trState.textContent = ''; renderCaptions(); return; }
  trState.textContent = 'Traduction…';
  try {
    const t = await translateText(src, S.base, other(S.base));
    if (job !== trJob) return;
    st.translation = t; trText.textContent = t; trState.textContent = '';
    st.sessTranslated = st.sessFinal.length;
    renderCaptions(); scheduleSave();
  } catch (e) { if (job === trJob) { trState.textContent = ''; toast(e.message); } }
}
function scheduleLiveTranslate() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    const raw = st.sessFinal;
    const delta = raw.slice(st.sessTranslated);
    if (!delta.trim()) return;
    st.sessTranslated = raw.length;
    translateDelta(delta);
  }, 700);
}
let trQueue = Promise.resolve();
function translateDelta(rawDelta) {
  const chunk = processChunk(rawDelta, st.translation ? '. ' : '');
  if (!chunk) return;
  trState.textContent = 'Traduction…';
  trQueue = trQueue.then(async () => {
    try {
      const t = await translateText(chunk, S.base, other(S.base));
      st.translation = join(st.translation, t);
      trText.textContent = st.translation;
      trText.scrollTop = trText.scrollHeight;
      trState.textContent = '';
      renderCaptions(); scheduleSave();
      if (S.autoSpeak && t.trim()) speakInterpreter(t);
    } catch (e) { trState.textContent = ''; toast(e.message); }
  });
}

function setTranslate(on) {
  S.translate = on; saveSettings(); syncLangUI();
  if (on) { st.translation = ''; trText.textContent = ''; scheduleFullTranslate(0); }
  renderCaptions();
}

// ================================================================ Synthèse vocale
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
  fillVoiceSelect($('#setVoiceFr'), 'fr', S.voiceFr);
  fillVoiceSelect($('#setVoiceEn'), 'en', S.voiceEn);
}
function fillVoiceSelect(sel, base, current) {
  const list = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  sel.innerHTML = '<option value="">Automatique</option>' + list.map((v) => `<option value="${esc(v.name)}" ${v.name === current ? 'selected' : ''}>${esc(v.name.replace(/\s*\(.*\)$/, ''))} · ${esc(v.lang)}</option>`).join('');
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function pickVoice(base) {
  const name = base === 'fr' ? S.voiceFr : S.voiceEn;
  if (name) { const v = voices.find((x) => x.name === name); if (v) return v; }
  const want = (S[base] || '').toLowerCase();
  const cands = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base));
  const score = (v) => (v.lang.toLowerCase().replace('_', '-') === want ? 4 : 0) + (/premium|enhanced|natural|neural|google/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return cands.sort((a, b) => score(b) - score(a))[0] || null;
}

let speakingBtn = null;
function speak(text, base, { onend, btn, queue = false } = {}) {
  if (!('speechSynthesis' in window)) { toast('La lecture vocale n\'est pas disponible sur cet appareil.'); return; }
  if (!queue) speechSynthesis.cancel();
  if (speakingBtn) speakingBtn.classList.remove('on');
  if (!text.trim()) { toast('Rien à lire pour le moment.'); return; }
  const parts = text.match(/[^.!?…\n]+[.!?…]*|\n+/g)?.map((p) => p.trim()).filter(Boolean) || [text];
  const v = pickVoice(base);
  speakingBtn = btn || null;
  if (btn) btn.classList.add('on');
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.lang = S[base]; if (v) u.voice = v; u.rate = S.rate;
    if (i === parts.length - 1) u.onend = u.onerror = () => { if (btn) btn.classList.remove('on'); speakingBtn = null; onend?.(); };
    speechSynthesis.speak(u);
  });
}
/** Mode interprète : on coupe le micro pendant la lecture pour ne pas se réécouter */
function speakInterpreter(t) {
  if (st.want && rec && !st.pausedForTTS) { st.pausedForTTS = true; try { rec.abort(); } catch { /* */ } }
  renderStatus();
  speak(t, other(S.base), {
    queue: true,
    onend: () => setTimeout(() => {
      if (speechSynthesis.speaking || speechSynthesis.pending) return;
      if (st.pausedForTTS) {
        st.pausedForTTS = false;
        if (st.want) { try { rec.lang = S[S.base]; rec.start(); } catch { stopListening(); } } else finishListening();
      }
    }, 80),
  });
}

// ================================================================ Notes & historique
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNote, 500); }
function getNotes() { return store.get('notes', []); }
function saveNote() {
  const text = st.listening ? liveText() : st.text;
  let notes = getNotes();
  if (!text.trim()) {
    if (st.noteId) { notes = notes.filter((n) => n.id !== st.noteId); store.set('notes', notes); }
    return;
  }
  if (!st.noteId) st.noteId = 'n' + Date.now().toString(36);
  const now = Date.now();
  const i = notes.findIndex((n) => n.id === st.noteId);
  const data = { id: st.noteId, text, tr: st.translation, base: S.base, updated: now, dur: st.elapsed + (st.startedAt ? now - st.startedAt : 0) };
  if (i >= 0) notes[i] = { ...notes[i], ...data }; else notes.unshift({ ...data, created: now });
  notes.sort((a, b) => b.updated - a.updated);
  store.set('notes', notes.slice(0, 300));
  store.set('current', st.noteId);
}
function openNote(id) {
  const n = getNotes().find((x) => x.id === id);
  if (!n) return;
  if (st.want) stopListening();
  st.noteId = n.id; st.text = n.text; st.translation = n.tr || ''; st.elapsed = n.dur || 0;
  if (n.base && n.base !== S.base) { S.base = n.base; saveSettings(); syncLangUI(); }
  setEditorFromText(); trText.textContent = st.translation;
  store.set('current', st.noteId);
  render();
}
function newNote() {
  if (st.want) stopListening();
  saveNote();
  st.noteId = null; st.text = ''; st.translation = ''; st.elapsed = 0;
  setEditorFromText(); trText.textContent = '';
  store.set('current', null);
  render();
  toast('Nouvelle note');
}
function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `Aujourd'hui ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function renderHistory() {
  const q = $('#histSearch').value.trim().toLowerCase();
  const notes = getNotes().filter((n) => !q || n.text.toLowerCase().includes(q) || (n.tr || '').toLowerCase().includes(q));
  const list = $('#histList');
  if (!notes.length) { list.innerHTML = `<div class="hist-empty">${q ? 'Aucun résultat.' : 'Vos dictées apparaîtront ici automatiquement.'}</div>`; return; }
  list.innerHTML = notes.map((n) => `
    <div class="hist-item ${n.id === st.noteId ? 'current' : ''}" data-id="${n.id}" role="button" tabindex="0">
      <div class="hist-main"><p>${esc(n.text)}</p>
        <div class="hist-meta"><span class="tag">${(n.base || 'fr').toUpperCase()}</span><span>${fmtDate(n.updated)}</span><span>${wordsOf(n.text)} mots</span>${n.tr ? '<span>· traduite</span>' : ''}</div></div>
      <button class="hist-del" data-del="${n.id}" aria-label="Supprimer"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
    </div>`).join('');
}
$('#histList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = del.dataset.del;
    const notes = getNotes(); const removed = notes.find((n) => n.id === id);
    store.set('notes', notes.filter((n) => n.id !== id));
    if (id === st.noteId) { st.noteId = null; }
    renderHistory();
    toast('Note supprimée', 'Annuler', () => { store.set('notes', [removed, ...getNotes()].sort((a, b) => b.updated - a.updated)); renderHistory(); });
    return;
  }
  const it = e.target.closest('[data-id]');
  if (it) { openNote(it.dataset.id); closeSheets(); }
});
$('#histSearch').addEventListener('input', renderHistory);
$('#exportAll').addEventListener('click', () => {
  const notes = getNotes();
  if (!notes.length) return toast('Aucune note à exporter.');
  const body = notes.map((n) => `— ${new Date(n.updated).toLocaleString('fr-FR')} (${(n.base || 'fr').toUpperCase()})\n${n.text}${n.tr ? `\n\n[Traduction]\n${n.tr}` : ''}`).join('\n\n\n');
  download(body, `echo-notes-${new Date().toISOString().slice(0, 10)}.txt`);
});

// ================================================================ Actions
function currentText() { return st.listening ? liveText() : st.text; }
async function copy(text, label = 'Texte copié') {
  if (!text.trim()) return toast('Rien à copier pour le moment.');
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(label); haptic();
}
function download(text, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function share() {
  const text = currentText() + (S.translate && st.translation ? `\n\n— ${LANG_NAME[other(S.base)]} —\n${st.translation}` : '');
  if (!text.trim()) return toast('Rien à partager pour le moment.');
  if (navigator.share) { try { await navigator.share({ text }); } catch { /* annulé */ } }
  else copy(text, 'Copié — collez-le où vous voulez');
}
function clearText() {
  if (st.want) stopListening();
  const backup = { text: st.text, tr: st.translation };
  if (!backup.text) return;
  st.text = ''; st.translation = ''; setEditorFromText(); trText.textContent = ''; render(); saveNote();
  toast('Texte effacé', 'Annuler', () => { st.text = backup.text; st.translation = backup.tr; setEditorFromText(); trText.textContent = backup.tr; render(); saveNote(); });
}

$('#micBtn').addEventListener('click', toggleListening);
$('#capMic').addEventListener('click', toggleListening);
$('#copyBtn').addEventListener('click', () => copy(currentText()));
$('#readBtn').addEventListener('click', (e) => {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); e.currentTarget.classList.remove('on'); return; }
  speak(currentText(), S.base);
});
$('#shareBtn').addEventListener('click', share);
$('#moreBtn').addEventListener('click', () => openSheet('moreSheet'));
$('#newBtn').addEventListener('click', newNote);
$('#historyBtn').addEventListener('click', () => { saveNote(); renderHistory(); openSheet('historySheet'); });
$('#settingsBtn').addEventListener('click', () => openSheet('settingsSheet'));
$('#trToggle').addEventListener('click', () => setTranslate(!S.translate));
$('#trSpeak').addEventListener('click', (e) => {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); e.currentTarget.classList.remove('on'); return; }
  speak(st.translation, other(S.base), { btn: e.currentTarget });
});
$('#trCopy').addEventListener('click', () => copy(st.translation, 'Traduction copiée'));
$$('.seg [data-lang]').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.lang)));
$('#moreSheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  closeSheets();
  ({
    captions: openCaptions,
    download: () => (currentText().trim() ? download(currentText() + (st.translation ? `\n\n[Traduction]\n${st.translation}` : ''), `dictee-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`) : toast('Rien à télécharger pour le moment.')),
    new: newNote,
    clear: clearText,
  })[b.dataset.act]?.();
});

// Raccourci clavier (ordinateur)
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) { e.preventDefault(); toggleListening(); }
  if (e.key === 'Escape') { closeSheets(); closeQuick(); closeCaptions(); }
});

// ================================================================ Feuilles
function openSheet(id) {
  closeSheets(); closeQuick();
  $('#backdrop').hidden = false; $('#' + id).hidden = false;
  renderBubbleCap();
}
function closeSheets() { $$('.sheet').forEach((s) => { s.hidden = true; }); $('#backdrop').hidden = true; renderBubbleCap(); }
$('#backdrop').addEventListener('click', closeSheets);
$$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

// ================================================================ Sous-titres plein écran
function openCaptions() { closeQuick(); $('#captions').hidden = false; renderCaptions(); renderBubbleCap(); }
function closeCaptions() { $('#captions').hidden = true; renderBubbleCap(); }
$('#capClose').addEventListener('click', closeCaptions);
function lastWords(t, n) { const w = t.trim().split(/\s+/); return w.length > n ? '… ' + w.slice(-n).join(' ') : t.trim(); }
function renderCaptions() {
  if ($('#captions').hidden) return;
  const fin = lastWords(liveText().replace(/\n+/g, ' '), 38);
  const int = st.sessInterim.trim();
  $('#capText').innerHTML = esc(fin) + (int ? ` <span class="int">${esc(int)}</span>` : '') || '';
  if (!fin && !int) $('#capText').innerHTML = '<span class="int">Touchez le micro et parlez…</span>';
  $('#capTr').textContent = S.translate ? lastWords(st.translation.replace(/\n+/g, ' '), 30) : '';
  $('#capBadge').textContent = S.translate ? `${S.base.toUpperCase()} → ${other(S.base).toUpperCase()}` : S.base.toUpperCase();
}

// ================================================================ Bulle flottante (AssistiveTouch)
const B = { size: 62, margin: 10, x: 0, y: 0 };
let editorVisible = true;
new IntersectionObserver((ents) => { editorVisible = ents[0].isIntersecting; renderBubbleCap(); }, { threshold: 0.2 }).observe(editor);

function bubbleBounds() {
  const vv = window.visualViewport;
  const W = vv ? vv.width : innerWidth, H = vv ? vv.height : innerHeight;
  const cs = getComputedStyle(document.documentElement);
  const st_ = parseFloat(cs.getPropertyValue('--safe-t')) || 0;
  return { W, H, minY: 12 + st_, maxY: H - B.size - 110 };
}
function placeBubble(x, y, snap = false) {
  const { W, H, minY, maxY } = bubbleBounds();
  B.x = Math.min(Math.max(x, B.margin), W - B.size - B.margin);
  B.y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
  bubble.classList.toggle('snapping', snap);
  bubble.style.left = B.x + 'px'; bubble.style.top = B.y + 'px';
  renderBubbleCap();
}
function snapBubble() {
  const { W } = bubbleBounds();
  const x = B.x + B.size / 2 < W / 2 ? B.margin : W - B.size - B.margin;
  placeBubble(x, B.y, true);
  S.bubblePos = { side: x === B.margin ? 'l' : 'r', yr: B.y / bubbleBounds().H }; saveSettings();
}
function initBubble() {
  const { W, H } = bubbleBounds();
  const p = S.bubblePos || { side: 'r', yr: 0.55 };
  placeBubble(p.side === 'l' ? B.margin : W - B.size - B.margin, p.yr * H);
  bubble.hidden = !S.bubble;
}
let idleTimer = null;
function wake() { bubble.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!st.want) bubble.classList.add('idle'); }, 3000); }

let drag = null, lpTimer = null, lastTap = 0, tapTimer = null;
bubble.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  wake();
  bubble.setPointerCapture(e.pointerId);
  drag = { x0: e.clientX, y0: e.clientY, bx: B.x, by: B.y, moved: false, long: false };
  lpTimer = setTimeout(() => { if (drag && !drag.moved) { drag.long = true; haptic(15); openQuick(); } }, 480);
});
bubble.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) > 8) { drag.moved = true; clearTimeout(lpTimer); bubble.classList.add('dragging'); closeQuick(); }
  if (drag.moved) placeBubble(drag.bx + dx, drag.by + dy);
});
const endDrag = () => {
  if (!drag) return;
  clearTimeout(lpTimer);
  bubble.classList.remove('dragging');
  const d = drag; drag = null;
  if (d.moved) { snapBubble(); return; }
  if (d.long) return;
  const now = Date.now();
  if (now - lastTap < 300) { clearTimeout(tapTimer); lastTap = 0; openCaptions(); return; }
  lastTap = now;
  tapTimer = setTimeout(() => { if (!quick.hidden) { closeQuick(); return; } toggleListening(); }, 260);
};
bubble.addEventListener('pointerup', endDrag);
bubble.addEventListener('pointercancel', endDrag);
bubble.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleListening(); } });

function openQuick() {
  quick.hidden = false;
  $('[data-q="tr"]', quick).classList.toggle('on', S.translate);
  const { W } = bubbleBounds();
  const qw = 196, qh = 190;
  const left = B.x + B.size / 2 < W / 2 ? B.x + B.size + 10 : B.x - qw - 10;
  const top = Math.min(Math.max(B.y + B.size / 2 - qh / 2, 12), bubbleBounds().H - qh - 12);
  quick.style.left = left + 'px'; quick.style.top = top + 'px';
  bubbleCap.hidden = true;
}
function closeQuick() { quick.hidden = true; renderBubbleCap(); }
quick.addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]'); if (!b) return;
  const q = b.dataset.q;
  if (q === 'lang') setBase(other(S.base));
  if (q === 'tr') setTranslate(!S.translate);
  if (q === 'copy') copy(currentText());
  if (q === 'captions') openCaptions();
  closeQuick();
});
document.addEventListener('pointerdown', (e) => { if (!quick.hidden && !quick.contains(e.target) && !bubble.contains(e.target)) closeQuick(); });

/** Sous-titre à côté de la bulle quand le texte principal n'est pas visible */
function renderBubbleCap() {
  const sheetOpen = $$('.sheet').some((s) => !s.hidden);
  const show = S.bubble && st.want && quick.hidden && $('#captions').hidden && (!editorVisible || sheetOpen);
  bubbleCap.hidden = !show;
  if (!show) return;
  const fin = liveText().replace(/\n+/g, ' ');
  const tail = fin.length > 110 ? '…' + fin.slice(-110) : fin;
  const int = st.sessInterim.trim();
  bubbleCap.innerHTML = (esc(tail) + (int ? ` <em>${esc(int)}</em>` : '')) || '<em>À l\'écoute…</em>';
  const { W } = bubbleBounds();
  const onLeft = B.x + B.size / 2 < W / 2;
  bubbleCap.style.top = (B.y + 6) + 'px';
  if (onLeft) { bubbleCap.style.left = (B.x + B.size + 10) + 'px'; bubbleCap.style.right = 'auto'; }
  else { bubbleCap.style.right = (W - B.x + 10) + 'px'; bubbleCap.style.left = 'auto'; }
}
window.addEventListener('resize', () => placeBubble(B.x + B.size / 2 < innerWidth / 2 ? B.margin : innerWidth, B.y, false));

// ================================================================ Réglages
function applyTheme() {
  const dark = S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0b0d14' : '#f6f7fb'));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
function applySize() { document.documentElement.style.setProperty('--fs', S.size + 'px'); $('#sizeVal').textContent = S.size + ' px'; }

function bindSettings() {
  const bindSel = (id, key, after) => { const el = $(id); el.value = S[key]; el.addEventListener('change', () => { S[key] = el.value; saveSettings(); after?.(); }); };
  const bindChk = (id, key, after) => { const el = $(id); el.checked = !!S[key]; el.addEventListener('change', () => { S[key] = el.checked; saveSettings(); after?.(); }); };
  bindSel('#setFr', 'fr', () => { if (st.want && S.base === 'fr') { setBase('en', { restart: false }); setBase('fr'); } });
  bindSel('#setEn', 'en', () => { if (st.want && S.base === 'en') { setBase('fr', { restart: false }); setBase('en'); } });
  bindChk('#setCmd', 'commands'); bindChk('#setCap', 'autoCap'); bindChk('#setWake', 'wake');
  bindChk('#setAuto', 'autoSpeak', () => { if (S.autoSpeak && !S.translate) setTranslate(true); });
  bindSel('#setVoiceFr', 'voiceFr'); bindSel('#setVoiceEn', 'voiceEn');
  bindSel('#setTheme', 'theme', applyTheme);
  bindChk('#setBubble', 'bubble', () => { bubble.hidden = !S.bubble; renderBubbleCap(); });
  const rate = $('#setRate'); rate.value = S.rate; $('#rateVal').textContent = S.rate.toFixed(1).replace('.', ',') + '×';
  rate.addEventListener('input', () => { S.rate = Number(rate.value); $('#rateVal').textContent = S.rate.toFixed(1).replace('.', ',') + '×'; saveSettings(); });
  const size = $('#setSize'); size.value = S.size;
  size.addEventListener('input', () => { S.size = Number(size.value); applySize(); saveSettings(); });
  $('#wipeAll').addEventListener('click', () => {
    const backup = getNotes();
    if (!backup.length) return toast('Aucune note enregistrée.');
    store.set('notes', []); newNote();
    toast(`${backup.length} note(s) supprimée(s)`, 'Annuler', () => store.set('notes', backup));
  });
}

// ================================================================ Installation
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; renderInstallHelp(); });
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('Écho est installée sur votre appareil 🎉'); });
$('#installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').hidden = true; });
function renderInstallHelp() {
  const el = $('#installHelp');
  if (isStandalone) { el.innerHTML = '✅ Écho est déjà installée et s\'ouvre comme une application.'; return; }
  if (isIOS) {
    el.innerHTML = `Sur iPhone / iPad, dans <b>Safari</b> :<ol><li>Touchez le bouton <b>Partager</b> (carré avec une flèche).</li><li>Choisissez <b>Sur l'écran d'accueil</b>.</li><li>Touchez <b>Ajouter</b>. L'icône Écho apparaît comme une appli.</li></ol>
      <p class="hint" style="margin-top:10px">Astuce : <b>Réglages → Accessibilité → Toucher → Toucher le dos</b>, puis associez « Double toucher » à un raccourci qui ouvre Écho. Deux tapotements au dos du téléphone lancent la dictée.</p>`;
  } else if (installEvt) {
    el.innerHTML = 'Touchez le bouton ci-dessous pour installer Écho comme une application.<br><br><button class="btn-ghost" id="installBtn2">Installer Écho</button>';
    $('#installBtn2').onclick = () => $('#installBtn').click();
  } else if (isAndroid) {
    el.innerHTML = 'Dans <b>Chrome</b> : menu <b>⋮</b> → <b>Ajouter à l\'écran d\'accueil</b> (ou « Installer l\'application »).';
  } else {
    el.innerHTML = 'Dans <b>Chrome</b> ou <b>Edge</b> : cliquez sur l\'icône d\'installation à droite de la barre d\'adresse, ou menu → <b>Installer Écho</b>.';
  }
}

// ================================================================ Bannières & retours
function notice(html, kind = '') {
  const n = $('#notice');
  n.className = 'notice ' + kind;
  n.innerHTML = `<div>${html}</div><button class="x" aria-label="Fermer"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
  n.hidden = false;
  n.querySelector('.x').onclick = hideNotice;
}
function hideNotice() { $('#notice').hidden = true; }
let toastTimer = null;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : '');
  if (actionLabel) t.querySelector('button').onclick = () => { action(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 5000 : 2200);
}
function haptic(ms = 8) { try { navigator.vibrate?.(ms); } catch { /* */ } }

// Sauvegarde immédiate quand l'appli passe en arrière-plan ou se ferme
window.addEventListener('pagehide', () => saveNote());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNote(); });

// ================================================================ Démarrage
function boot() {
  applyTheme(); applySize(); bindSettings(); syncLangUI(); renderInstallHelp(); initBubble(); wake();
  const cur = store.get('current', null);
  if (cur && getNotes().some((n) => n.id === cur)) openNote(cur); else render();
  if (!SR) {
    notice(isIOS
      ? 'Pour dicter ici, touchez la zone de texte puis la touche <b>micro 🎤 du clavier</b>. Pour la dictée en direct, ouvrez Écho dans Safari.'
      : '<b>Ce navigateur ne propose pas la dictée en direct.</b> Ouvrez Écho dans Chrome, Edge ou Safari.', 'warn');
  } else if (isIOS && !isStandalone && !store.get('iosTip', false)) {
    notice('📲 <b>Ajoutez Écho à l\'écran d\'accueil</b> : bouton Partager → « Sur l\'écran d\'accueil ».');
    $('#notice .x').addEventListener('click', () => store.set('iosTip', true));
  }
  // Raccourci « Nouvelle dictée » depuis l'icône de l'appli
  if (new URLSearchParams(location.search).get('start') === '1') { newNote(); setTimeout(startListening, 400); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
