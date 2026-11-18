'use strict';
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'cm_token';
const MAX_RECORD_SECONDS = 300;

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}
let me = null, selected = null, contacts = [];
let lastId = 0, lastDay = '', lastSender = null;
let registerMode = false, pollTimer = null, pollBusy = false, tick = 0;
let recorder = null, recordStream = null, recordChunks = [], recordTimer = null, recordStart = 0, recordDiscard = false;
const audioCache = new Map();
let filter = 'all';

/* ---------- Thèmes ---------- */
const THEMES = [
  { id: 'classique', name: 'Classique', hint: 'Vert, suit le mode clair ou sombre' },
  { id: 'nuit', name: 'Nuit', hint: 'Sombre en permanence' },
  { id: 'douceur', name: 'Douceur', hint: 'Relief doux, bulles bleues' },
  { id: 'crepuscule', name: 'Crépuscule', hint: 'Paysage au coucher du soleil' },
  { id: 'foret', name: 'Forêt', hint: 'Vert profond et jaune' },
  { id: 'corail', name: 'Corail', hint: 'Rouge corail lumineux' },
];
function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem('cm_theme', id); } catch {}
  syncThemeColor();
  document.querySelectorAll('.theme-card').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.id === id)));
}
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
  if (color) document.querySelector('meta[name="theme-color"]').content = color;
}
function buildThemeGrid() {
  const current = document.documentElement.dataset.theme;
  $('theme-grid').replaceChildren(...THEMES.map(t => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.id = t.id;
    card.setAttribute('aria-pressed', String(t.id === current));
    const preview = document.createElement('div');
    preview.className = 'theme-preview';
    preview.dataset.theme = t.id; // la vignette utilise les vraies variables du thème
    for (const cls of ['', 'm', 'd']) { const bar = document.createElement('i'); bar.className = cls; preview.append(bar); }
    const label = document.createElement('span');
    label.textContent = t.name;
    const hint = document.createElement('small');
    hint.textContent = t.hint;
    label.append(hint);
    card.append(preview, label);
    card.onclick = () => applyTheme(t.id);
    return card;
  }));
}
document.querySelectorAll('.theme-open').forEach(b => { b.onclick = () => { buildThemeGrid(); $('theme-dialog').showModal(); }; });
$('theme-close').onclick = () => $('theme-dialog').close();
$('theme-dialog').onclick = e => { if (e.target === $('theme-dialog')) $('theme-dialog').close(); };
syncThemeColor();

/* ---------- Outils ---------- */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
let toastTimer = null;
function toast(message, isError) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', !!isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
function setToken(value) {
  token = value;
  try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}) };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (opts.json) {
    opts.method = opts.method || 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
  }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new Error('Connexion au serveur impossible. Vérifiez votre réseau.'); }
  if (res.status === 401 && me) { signOut('Votre session a expiré. Reconnectez-vous.'); throw new Error('Session expirée.'); }
  if (opts.blob && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Une erreur est survenue.');
  return data;
}
function initial(name) { return (Array.from(name.trim())[0] || '?').toUpperCase(); }
function paintAvatar(node, user) {
  let h = 0;
  for (const c of user.username) h = (h * 31 + c.charCodeAt(0)) % 360;
  node.textContent = initial(user.display_name);
  node.style.setProperty('--h', h); // la teinte ; chaque thème décide du rendu
}
const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
function dayLabel(d) {
  const today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return "Aujourd'hui";
  if (dayKey(d) === dayKey(yesterday)) return 'Hier';
  return dayFmt.format(d);
}
function shortTime(d) { return dayKey(d) === dayKey(new Date()) ? timeFmt.format(d) : shortFmt.format(d); }

/* ---------- Connexion ---------- */
function applyAuthMode() {
  document.querySelectorAll('.register-only').forEach(n => { n.hidden = !registerMode; });
  $('auth-title').textContent = registerMode ? 'Créer un compte' : 'Bienvenue !';
  $('auth-desc').textContent = registerMode ? 'Rejoignez COOL MESSENGER en quelques secondes.' : 'Connectez-vous pour retrouver vos conversations.';
  $('auth-submit').textContent = registerMode ? 'Créer mon compte' : 'Se connecter';
  $('toggle-label').textContent = registerMode ? 'Déjà inscrit ?' : 'Nouveau ici ?';
  $('toggle').textContent = registerMode ? 'Se connecter' : 'Créer un compte';
  $('password').autocomplete = registerMode ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
}
$('toggle').onclick = () => { registerMode = !registerMode; applyAuthMode(); };
$('show-password').onclick = () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('show-password').textContent = show ? 'Masquer' : 'Afficher';
  $('show-password').setAttribute('aria-pressed', String(show));
};
$('auth-form').onsubmit = async e => {
  e.preventDefault();
  const username = $('username').value.trim(), password = $('password').value;
  const fail = msg => { $('auth-error').textContent = msg; };
  if (!username || !password) return fail('Saisissez votre nom d\'utilisateur et votre mot de passe.');
  if (registerMode && !$('display').value.trim()) return fail('Saisissez le nom à afficher.');
  if (registerMode && password.length < 8) return fail('Le mot de passe doit contenir au moins 8 caractères.');
  fail('');
  $('auth-submit').disabled = true;
  try {
    const data = registerMode
      ? await api('/api/register', { json: { username, display_name: $('display').value, password, phone: $('phone').value.trim() || null } })
      : await api('/api/login', { json: { username, password } });
    setToken(data.token);
    $('password').value = '';
    await start();
  } catch (err) { fail(err.message); }
  finally { $('auth-submit').disabled = false; }
};
function signOut(message) {
  setToken(null);
  clearInterval(pollTimer);
  stopRecording(true);
  audioCache.forEach(url => URL.revokeObjectURL(url));
  audioCache.clear();
  me = null; selected = null; contacts = []; renderedSignature = '';
  $('app').hidden = true;
  $('app').classList.remove('chat-open');
  $('chat-inner').hidden = true;
  $('placeholder').hidden = false;
  $('messages').replaceChildren();
  $('contacts').replaceChildren();
  $('auth').hidden = false;
  document.title = 'COOL MESSENGER';
  applyAuthMode();
  if (message) $('auth-error').textContent = message;
}
$('logout').onclick = () => signOut();

async function start() {
  try { me = await api('/api/me'); }
  catch { setToken(null); $('auth').hidden = false; return; }
  $('auth').hidden = true;
  $('app').hidden = false;
  $('me-name').textContent = me.display_name;
  $('me-user').textContent = '@' + me.username;
  paintAvatar($('me-avatar'), me);
  api('/api/config').then(cfg => {
    $('sms-open').hidden = !cfg.sms_enabled;
    $('sms-info').textContent = `SMS classique vers n'importe quel numéro. Limite : ${cfg.sms_daily_limit} par jour.`;
  }).catch(() => {});
  await loadContacts();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 3000);
}

/* ---------- Contacts ---------- */
async function loadContacts() {
  const q = $('search').value.trim();
  let rows;
  try { rows = await api('/api/users?q=' + encodeURIComponent(q)); }
  catch (err) { if (!contacts.length && me) $('contacts').replaceChildren(el('div', 'list-note', err.message)); return; }
  if (!me || q !== $('search').value.trim()) return;
  contacts = rows;
  renderContacts(q);
}
let renderedSignature = '';
function renderContacts(q) {
  // Ne redessine la liste que si quelque chose a changé (évite de perdre le focus ou un clic en cours).
  const signature = JSON.stringify([contacts, selected && selected.id, q, filter, dayKey(new Date())]);
  if (signature === renderedSignature && $('contacts').childElementCount) return;
  renderedSignature = signature;
  const box = $('contacts');
  const unreadOf = u => (selected && selected.id === u.id ? 0 : u.unread);
  const unreadTotal = contacts.reduce((n, u) => n + unreadOf(u), 0);
  $('unread-count').hidden = !unreadTotal;
  $('unread-count').textContent = unreadTotal > 99 ? '99+' : String(unreadTotal);
  const shown = filter === 'unread' ? contacts.filter(u => unreadOf(u) || (selected && selected.id === u.id)) : contacts;
  const nodes = shown.map(u => {
    const unread = unreadOf(u);
    const row = el('button', 'contact' + (selected && selected.id === u.id ? ' active' : '') + (unread ? ' unread' : ''));
    row.type = 'button';
    const av = el('span', 'avatar');
    paintAvatar(av, u);
    const main = el('div', 'contact-main');
    const top = el('div', 'contact-top');
    top.append(el('span', 'contact-name', u.display_name));
    if (u.last) top.append(el('span', 'contact-time', shortTime(new Date(u.last.created_at))));
    const bottom = el('div', 'contact-bottom');
    const preview = u.last ? (u.last.mine ? 'Vous : ' : '') + (u.last.voice ? 'Message vocal' : u.last.body) : '@' + u.username;
    bottom.append(el('span', 'contact-sub', preview));
    if (unread) bottom.append(el('span', 'badge', unread > 99 ? '99+' : String(unread)));
    main.append(top, bottom);
    row.append(av, main);
    row.onclick = () => openChat(u);
    return row;
  });
  if (!nodes.length) nodes.push(el('div', 'list-note', filter === 'unread' ? 'Aucun message non lu.' : q ?'Aucun contact ne correspond à cette recherche.' : 'Aucun autre utilisateur pour le moment. Invitez vos proches à créer un compte.'));
  box.replaceChildren(...nodes);
  document.title = (unreadTotal ? `(${unreadTotal}) ` : '') + 'COOL MESSENGER';
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    filter = tab.dataset.filter;
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-pressed', String(t === tab));
    });
    renderContacts($('search').value.trim());
  };
});
let searchTimer = null;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadContacts, 250); };

/* ---------- Conversation ---------- */
async function openChat(u) {
  stopRecording(true);
  selected = u;
  lastId = 0; lastDay = ''; lastSender = null;
  $('app').classList.add('chat-open');
  $('placeholder').hidden = true;
  $('chat-inner').hidden = false;
  $('chat-name').textContent = u.display_name;
  $('chat-user').textContent = '@' + u.username;
  paintAvatar($('chat-avatar'), u);
  $('messages').replaceChildren(el('div', 'list-note', 'Chargement…'));
  renderContacts($('search').value.trim());
  try {
    const rows = await api('/api/messages/' + u.id);
    if (selected !== u) return;
    $('messages').replaceChildren();
    if (!rows.length) $('messages').append(el('div', 'list-note', 'Aucun message. Dites bonjour 👋'));
    appendMessages(rows, true);
  } catch (err) {
    if (selected === u) $('messages').replaceChildren(el('div', 'list-note', err.message));
  }
  if (matchMedia('(min-width: 761px)').matches) $('message').focus();
}
$('back').onclick = () => {
  stopRecording(true);
  selected = null;
  $('app').classList.remove('chat-open');
  $('chat-inner').hidden = true;
  $('placeholder').hidden = false;
  loadContacts();
};
function voiceNode(m) {
  const btn = el('button', 'voice');
  btn.type = 'button';
  const play = el('span', 'play');
  play.append(icon('i-play'));
  const label = el('span', '', 'Message vocal');
  btn.append(play, label);
  btn.onclick = async () => {
    btn.disabled = true;
    label.textContent = 'Chargement…';
    try {
      let url = audioCache.get(m.id);
      if (!url) {
        url = URL.createObjectURL(await api(m.media_url, { blob: true }));
        audioCache.set(m.id, url);
      }
      const audio = el('audio');
      audio.controls = true;
      audio.src = url;
      btn.replaceWith(audio);
      audio.play().catch(() => {});
    } catch (err) {
      btn.disabled = false;
      label.textContent = 'Message vocal';
      toast(err.message, true);
    }
  };
  return btn;
}
function appendMessages(rows, forceScroll) {
  if (!rows.length) return;
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (!lastId) { const note = box.querySelector('.list-note'); if (note) note.remove(); }
  for (const m of rows) {
    if (m.id <= lastId) continue;
    const date = new Date(m.created_at), key = dayKey(date);
    if (key !== lastDay) { box.append(el('div', 'day', dayLabel(date))); lastDay = key; lastSender = null; }
    const mine = m.sender_id === me.id;
    const bubble = el('div', 'bubble ' + (mine ? 'mine' : 'theirs') + (lastSender !== null && lastSender !== m.sender_id ? ' gap' : ''));
    if (m.media_url) bubble.append(voiceNode(m));
    else bubble.append(el('div', '', m.body || ''));
    bubble.append(el('div', 'time', timeFmt.format(date)));
    box.append(bubble);
    lastId = m.id; lastSender = m.sender_id;
  }
  if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}
async function fetchNew(forceScroll) {
  const u = selected;
  if (!u) return;
  const rows = await api(`/api/messages/${u.id}?after=${lastId}`);
  if (selected === u) appendMessages(rows, forceScroll);
}
async function poll() {
  if (!me || document.hidden || pollBusy) return;
  pollBusy = true;
  try {
    if (selected) await fetchNew(false);
    if (++tick % 2 === 0 || !selected) await loadContacts();
  } catch {} finally { pollBusy = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ---------- Envoi de texte ---------- */
const input = $('message');
function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight + 2, 140) + 'px';
  $('send').disabled = !input.value.trim();
}
input.oninput = resizeInput;
input.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
};
$('composer').onsubmit = async e => {
  e.preventDefault();
  const body = input.value.trim();
  if (!body || !selected || $('send').dataset.busy) return;
  $('send').dataset.busy = '1';
  try {
    await api('/api/messages', { json: { recipient_id: selected.id, body } });
    input.value = '';
    resizeInput();
    await fetchNew(true);
    loadContacts();
  } catch (err) { toast(err.message, true); }
  finally { delete $('send').dataset.busy; }
};

/* ---------- Messages vocaux ---------- */
function showRecording(on) {
  $('compose-row').hidden = on;
  $('record-row').hidden = !on;
}
async function startRecording() {
  if (!selected || recorder) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    return toast('Le micro n\'est pas disponible. Utilisez HTTPS (ou localhost) et un navigateur récent.', true);
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Accès au micro refusé. Autorisez-le dans les réglages du navigateur.', true); }
  const target = selected;
  const type = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
    .find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  recordStream = stream;
  recordChunks = [];
  recordDiscard = false;
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const current = recorder;
  current.ondataavailable = e => { if (e.data.size) recordChunks.push(e.data); };
  current.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const discard = recordDiscard, chunks = recordChunks;
    if (recorder === current) { recorder = null; recordStream = null; }
    clearInterval(recordTimer);
    showRecording(false);
    if (discard || !chunks.length) return;
    const blob = new Blob(chunks, { type: current.mimeType || 'audio/webm' });
    const form = new FormData();
    form.append('recipient_id', target.id);
    form.append('audio', blob, 'vocal');
    try {
      await api('/api/voice', { method: 'POST', body: form });
      if (selected === target) await fetchNew(true);
      loadContacts();
    } catch (err) { toast(err.message, true); }
  };
  current.start();
  recordStart = Date.now();
  $('record-time').textContent = '0:00';
  showRecording(true);
  recordTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recordStart) / 1000);
    $('record-time').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    if (s >= MAX_RECORD_SECONDS) stopRecording(false);
  }, 250);
}
function stopRecording(discard) {
  if (!recorder || recorder.state === 'inactive') return;
  recordDiscard = discard;
  recorder.stop();
}
$('record').onclick = startRecording;
$('record-cancel').onclick = () => stopRecording(true);
$('record-send').onclick = () => stopRecording(false);

/* ---------- SMS ---------- */
$('sms-open').onclick = () => { $('sms-error').textContent = ''; $('sms-dialog').showModal(); };
$('sms-cancel').onclick = () => $('sms-dialog').close();
$('sms-form').onsubmit = async e => {
  e.preventDefault();
  $('sms-submit').disabled = true;
  $('sms-error').textContent = '';
  try {
    await api('/api/sms', { json: { to_number: $('sms-to').value, body: $('sms-body').value } });
    $('sms-body').value = '';
    $('sms-dialog').close();
    toast('SMS envoyé.');
  } catch (err) { $('sms-error').textContent = err.message; }
  finally { $('sms-submit').disabled = false; }
};

/* ---------- Installation sur téléphone ---------- */
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;
function installDismissed() { try { return localStorage.getItem('cm_install_hidden') === '1'; } catch { return false; } }
function refreshInstall() {
  const possible = !isStandalone && (installPrompt !== null || isIOS);
  $('install-card').hidden = !possible || installDismissed();
  document.querySelector('.auth-install').hidden = !possible;
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; refreshInstall(); });
window.addEventListener('appinstalled', () => { installPrompt = null; refreshInstall(); toast('Application installée sur cet appareil.'); });
document.querySelectorAll('.install-btn').forEach(b => {
  b.onclick = async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      prompt.prompt();
      await prompt.userChoice.catch(() => {});
      refreshInstall();
    } else if (isIOS) {
      $('ios-install').showModal();
    }
  };
});
$('install-close').onclick = () => {
  try { localStorage.setItem('cm_install_hidden', '1'); } catch {}
  refreshInstall();
};
$('ios-install-close').onclick = () => $('ios-install').close();
refreshInstall();

/* Clavier du téléphone : l'iPhone ne réduit pas la page quand le clavier s'ouvre,
   la zone de saisie passerait dessous. On ajuste la hauteur à la partie visible. */
if (window.visualViewport) {
  const fit = () => {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    document.documentElement.style.setProperty('--app-h', Math.round(visualViewport.height) + 'px');
    if (window.scrollY) window.scrollTo(0, 0);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  };
  visualViewport.addEventListener('resize', fit);
  fit();
}

/* ---------- Démarrage ---------- */
applyAuthMode();
if (token) start(); else $('auth').hidden = false;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
