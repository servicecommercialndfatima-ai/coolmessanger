'use strict';
// Écrit sans syntaxe trop récente (pas de « ?. » ni « ?? ») pour fonctionner sur les iPhone depuis iOS 12.
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'cm_token';
const MAX_RECORD_SECONDS = 300;

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
let me = null;          // mon compte
let selected = null;    // conversation ouverte : { type: 'user' | 'group', id, display_name, ... }
let convs = [];         // liste des conversations (contacts et groupes)
let lastId = 0, lastDay = '', lastSender = null;
let registerMode = false, pollTimer = null, pollBusy = false, tick = 0;
let recorder = null, recordStream = null, recordChunks = [], recordTimer = null, recordStart = 0, recordDiscard = false;
let filter = 'all';
let cfg = { max_file_mb: { voice: 12, audio: 15, image: 8, video: 20 } };
const mediaCache = new Map();   // message -> adresse locale du fichier déjà téléchargé
const avatarCache = new Map();  // "id:version" -> promesse de l'adresse locale de la photo

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
  svg.appendChild(use);
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
  try { if (value) localStorage.setItem(TOKEN_KEY, value); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
}
function errorText(data, fallback) { return data && typeof data.detail === 'string' ? data.detail : fallback; }
async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {});
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (opts.json) {
    opts.method = opts.method || 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
  }
  let res;
  try { res = await fetch(path, opts); }
  catch (e) { throw new Error('Connexion au serveur impossible. Vérifiez votre réseau.'); }
  if (res.status === 401 && me) { signOut('Votre session a expiré. Reconnectez-vous.'); throw new Error('Session expirée.'); }
  if (opts.blob && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorText(data, 'Une erreur est survenue.'));
  return data;
}
function initial(name) { return (Array.from(String(name || '').trim())[0] || '?').toUpperCase(); }
function hueOf(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function loadAvatar(id, version) {
  const key = id + ':' + version;
  if (!avatarCache.has(key)) {
    avatarCache.set(key, api('/api/users/' + id + '/avatar', { blob: true })
      .then(blob => URL.createObjectURL(blob)).catch(() => null));
  }
  return avatarCache.get(key);
}
// Pastille ronde : photo de profil si elle existe, sinon l'initiale sur un fond coloré.
function paintAvatar(node, who) {
  const isGroup = who.type === 'group';
  node.classList.toggle('group', isGroup);
  node.style.setProperty('--h', hueOf(isGroup ? 'g' + who.id + who.display_name : who.username));
  node.textContent = initial(who.display_name);
  const version = !isGroup && who.avatar_v;
  const key = version ? who.id + ':' + version : '';
  node.dataset.av = key;
  if (!version) return;
  loadAvatar(who.id, version).then(url => {
    if (!url || node.dataset.av !== key) return;
    const img = el('img', 'avatar-img');
    img.alt = '';
    img.src = url;
    node.appendChild(img);
  });
}
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' Ko';
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
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
function isSelected(c) { return !!selected && selected.type === c.type && selected.id === c.id; }
function targetFields() { return selected.type === 'group' ? { group_id: selected.id } : { recipient_id: selected.id }; }
function historyUrl(c, after) {
  const base = c.type === 'group' ? '/api/groups/' + c.id + '/messages' : '/api/messages/' + c.id;
  return base + '?after=' + (after || 0);
}
// Ferme une fenêtre avec son bouton ✕ ou en touchant le fond.
document.querySelectorAll('dialog').forEach(d => {
  const close = d.querySelector('.dlg-close');
  if (close) close.onclick = () => d.close();
  d.addEventListener('click', e => { if (e.target === d && d.classList.contains('wide')) d.close(); });
});

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
  cancelUpload();
  mediaCache.forEach(p => p.then(url => { if (url) URL.revokeObjectURL(url); }));
  mediaCache.clear();
  avatarCache.clear();
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  me = null; selected = null; convs = []; renderedSignature = '';
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

function showMe() {
  $('me-name').textContent = me.display_name;
  $('me-user').textContent = '@' + me.username;
  paintAvatar($('me-avatar'), me);
}
async function start() {
  try { me = await api('/api/me'); }
  catch (e) { setToken(null); $('auth').hidden = false; return; }
  $('auth').hidden = true;
  $('app').hidden = false;
  showMe();
  api('/api/config').then(c => {
    cfg = c;
    $('sms-open').hidden = !c.sms_enabled;
    $('sms-info').textContent = 'SMS classique vers n\'importe quel numéro. Limite : ' + c.sms_daily_limit + ' par jour.';
  }).catch(() => {});
  await loadConvs();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 3000);
}

/* ---------- Liste des conversations ---------- */
async function loadConvs() {
  const q = $('search').value.trim();
  let rows;
  try { rows = await api('/api/conversations?q=' + encodeURIComponent(q)); }
  catch (err) { if (!convs.length && me) $('contacts').replaceChildren(el('div', 'list-note', err.message)); return; }
  if (!me || q !== $('search').value.trim()) return;
  convs = rows;
  // La conversation ouverte suit les changements (nom du groupe, blocage…).
  if (selected) {
    const fresh = convs.find(isSelected);
    if (fresh) { Object.assign(selected, fresh); refreshHeader(); }
  }
  renderConvs(q);
}
let renderedSignature = '';
function previewText(c) {
  if (!c.last) return c.type === 'group' ? c.members + ' membres' : '@' + c.username;
  let who = '';
  if (c.last.mine) who = 'Vous : ';
  else if (c.type === 'group' && c.last.sender_name) who = c.last.sender_name.split(' ')[0] + ' : ';
  return who + c.last.body;
}
function renderConvs(q) {
  // Ne redessine la liste que si quelque chose a changé (évite de perdre le focus ou un clic en cours).
  const signature = JSON.stringify([convs, selected && selected.type + selected.id, q, filter, dayKey(new Date())]);
  if (signature === renderedSignature && $('contacts').childElementCount) return;
  renderedSignature = signature;
  const unreadOf = c => (isSelected(c) ? 0 : c.unread);
  const unreadTotal = convs.reduce((n, c) => n + unreadOf(c), 0);
  $('unread-count').hidden = !unreadTotal;
  $('unread-count').textContent = unreadTotal > 99 ? '99+' : String(unreadTotal);
  let shown = convs;
  if (filter === 'unread') shown = convs.filter(c => unreadOf(c) || isSelected(c));
  if (filter === 'groups') shown = convs.filter(c => c.type === 'group');
  const nodes = shown.map(c => {
    const unread = unreadOf(c);
    const row = el('button', 'contact' + (isSelected(c) ? ' active' : '') + (unread ? ' unread' : '') + (c.blocked ? ' blocked' : ''));
    row.type = 'button';
    const av = el('span', 'avatar');
    paintAvatar(av, c);
    const main = el('div', 'contact-main');
    const top = el('div', 'contact-top');
    const name = el('span', 'contact-name', c.display_name);
    if (c.type === 'group') name.prepend(icon('i-group'));
    top.appendChild(name);
    if (c.last) top.appendChild(el('span', 'contact-time', shortTime(new Date(c.last.created_at))));
    const bottom = el('div', 'contact-bottom');
    bottom.appendChild(el('span', 'contact-sub', c.blocked ? 'Contact bloqué' : previewText(c)));
    if (unread) bottom.appendChild(el('span', 'badge', unread > 99 ? '99+' : String(unread)));
    main.append(top, bottom);
    row.append(av, main);
    row.onclick = () => openConv(c);
    return row;
  });
  if (!nodes.length) {
    const text = filter === 'unread' ? 'Aucun message non lu.'
      : filter === 'groups' ? 'Aucun groupe. Touchez l\'icône « groupe » en haut pour en créer un.'
      : q ? 'Aucun contact ni groupe ne correspond à cette recherche.'
      : 'Aucun autre utilisateur pour le moment. Invitez vos proches à créer un compte.';
    nodes.push(el('div', 'list-note', text));
  }
  $('contacts').replaceChildren.apply($('contacts'), nodes);
  document.title = (unreadTotal ? '(' + unreadTotal + ') ' : '') + 'COOL MESSENGER';
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    filter = tab.dataset.filter;
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-pressed', String(t === tab));
    });
    renderConvs($('search').value.trim());
  };
});
let searchTimer = null;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadConvs, 250); };

/* ---------- Conversation ouverte ---------- */
function refreshHeader() {
  if (!selected) return;
  $('chat-name').textContent = selected.display_name;
  $('chat-user').textContent = selected.type === 'group'
    ? (selected.members ? selected.members + ' membres · toucher pour les infos' : 'Groupe')
    : (selected.blocked ? 'Contact bloqué' : '@' + selected.username);
  paintAvatar($('chat-avatar'), selected);
  const blocked = selected.type === 'user' && selected.blocked;
  $('blocked-bar').hidden = !blocked;
  $('composer').hidden = blocked;
  if (blocked) stopRecording(true);
}
async function openConv(c) {
  stopRecording(true);
  selected = Object.assign({}, c);
  lastId = 0; lastDay = ''; lastSender = null;
  $('app').classList.add('chat-open');
  $('placeholder').hidden = true;
  $('chat-inner').hidden = false;
  refreshHeader();
  $('messages').replaceChildren(el('div', 'list-note', 'Chargement…'));
  renderConvs($('search').value.trim());
  const opened = selected;
  try {
    const rows = await api(historyUrl(c, 0));
    if (selected !== opened) return;
    $('messages').replaceChildren();
    if (!rows.length) $('messages').appendChild(el('div', 'list-note', c.type === 'group' ? 'Aucun message. Lancez la discussion 👋' : 'Aucun message. Dites bonjour 👋'));
    appendMessages(rows, true);
  } catch (err) {
    if (selected === opened) $('messages').replaceChildren(el('div', 'list-note', err.message));
  }
  if (matchMedia('(min-width: 761px)').matches && !$('composer').hidden) $('message').focus();
}
function closeConv() {
  stopRecording(true);
  selected = null;
  $('app').classList.remove('chat-open');
  $('chat-inner').hidden = true;
  $('placeholder').hidden = false;
  loadConvs();
}
$('back').onclick = closeConv;

/* Fichiers reçus : téléchargés avec la session, puis gardés en mémoire. */
function loadMedia(m) {
  if (!mediaCache.has(m.id)) {
    mediaCache.set(m.id, api(m.media_url, { blob: true }).then(b => URL.createObjectURL(b)).catch(err => {
      mediaCache.delete(m.id);
      throw err;
    }));
  }
  return mediaCache.get(m.id);
}
function nearBottom(box, margin) { return box.scrollHeight - box.scrollTop - box.clientHeight < (margin || 120); }
function playableNode(m, label, iconName, makePlayer) {
  const btn = el('button', 'voice');
  btn.type = 'button';
  const play = el('span', 'play');
  play.appendChild(icon(iconName));
  const text = el('span', 'voice-label', label);
  btn.append(play, text);
  btn.onclick = async () => {
    btn.disabled = true;
    text.textContent = 'Chargement…';
    try {
      const player = makePlayer(await loadMedia(m));
      btn.replaceWith(player);
      const p = player.play && player.play();
      if (p && p.catch) p.catch(() => {});
    } catch (err) {
      btn.disabled = false;
      text.textContent = label;
      toast(err.message, true);
    }
  };
  return btn;
}
function audioPlayer(url) { const a = el('audio'); a.controls = true; a.src = url; return a; }
function videoPlayer(url) {
  const v = el('video', 'video');
  v.controls = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.src = url;
  return v;
}
function imageNode(m) {
  const box = el('button', 'photo');
  box.type = 'button';
  box.setAttribute('aria-label', 'Agrandir la photo');
  const img = el('img');
  img.alt = 'Photo';
  box.appendChild(img);
  const list = $('messages');
  loadMedia(m).then(url => {
    const stick = nearBottom(list, 300);
    img.onload = () => { box.classList.add('loaded'); if (stick) list.scrollTop = list.scrollHeight; };
    img.src = url;
  }).catch(() => { box.replaceChildren(el('span', 'muted', 'Photo indisponible')); });
  box.onclick = () => {
    if (!img.src) return;
    $('photo-full').src = img.src;
    $('photo-dialog').showModal();
  };
  return box;
}
function messageContent(m) {
  const kind = m.kind || (m.media_url ? 'voice' : 'text');
  if (kind === 'image' && m.media_url) return imageNode(m);
  if (kind === 'video' && m.media_url) {
    return playableNode(m, 'Vidéo' + (m.media_size ? ' · ' + formatSize(m.media_size) : ''), 'i-video', videoPlayer);
  }
  if (kind === 'audio' && m.media_url) return playableNode(m, m.media_name || 'Fichier audio', 'i-music', audioPlayer);
  if (m.media_url) return playableNode(m, 'Message vocal', 'i-play', audioPlayer);
  return el('div', 'text', m.body || '');
}
function appendMessages(rows, forceScroll) {
  if (!rows.length) return;
  const box = $('messages');
  const stick = nearBottom(box);
  if (!lastId) { const note = box.querySelector('.list-note'); if (note) note.remove(); }
  const inGroup = selected && selected.type === 'group';
  for (const m of rows) {
    if (m.id <= lastId) continue;
    const date = new Date(m.created_at), key = dayKey(date);
    if (key !== lastDay) { box.appendChild(el('div', 'day', dayLabel(date))); lastDay = key; lastSender = null; }
    const mine = m.sender_id === me.id;
    const kind = m.kind || 'text';
    const bubble = el('div', 'bubble ' + (mine ? 'mine' : 'theirs') + ' k-' + kind + (lastSender !== null && lastSender !== m.sender_id ? ' gap' : ''));
    if (inGroup && !mine && lastSender !== m.sender_id) {
      const name = el('div', 'sender', m.sender_name || 'Membre');
      name.style.setProperty('--h', hueOf('s' + m.sender_id));
      bubble.appendChild(name);
    }
    bubble.appendChild(messageContent(m));
    bubble.appendChild(el('div', 'time', timeFmt.format(date)));
    box.appendChild(bubble);
    lastId = m.id; lastSender = m.sender_id;
  }
  if (forceScroll || stick) box.scrollTop = box.scrollHeight;
}
async function fetchNew(forceScroll) {
  const c = selected;
  if (!c) return;
  const rows = await api(historyUrl(c, lastId));
  if (selected === c) appendMessages(rows, forceScroll);
}
async function poll() {
  if (!me || document.hidden || pollBusy) return;
  pollBusy = true;
  try {
    if (selected) await fetchNew(false);
    if (++tick % 2 === 0 || !selected) await loadConvs();
  } catch (e) {} finally { pollBusy = false; }
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
    await api('/api/messages', { json: Object.assign({ body: body }, targetFields()) });
    input.value = '';
    resizeInput();
    await fetchNew(true);
    loadConvs();
  } catch (err) { toast(err.message, true); }
  finally { delete $('send').dataset.busy; }
};

/* ---------- Envoi de fichiers (photo, vidéo, audio, vocal) ---------- */
let currentUpload = null;
const uploadQueue = [];
const KIND_NAMES = { image: 'La photo', video: 'La vidéo', audio: 'Le fichier audio', voice: 'Le vocal' };
function kindOf(file) {
  const type = file.type || '';
  if (type.indexOf('image/') === 0) return 'image';
  if (type.indexOf('video/') === 0) return 'video';
  if (type.indexOf('audio/') === 0) return 'audio';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (/^(jpe?g|png|gif|webp)$/.test(ext)) return 'image';
  if (/^(mp4|mov|3gp|webm|m4v)$/.test(ext)) return 'video';
  if (/^(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/.test(ext)) return 'audio';
  return null;
}
// Réduit les photos avant l'envoi (une photo de téléphone passe de 4 Mo à environ 300 Ko).
function shrinkImage(file, maxSide, quality, square) {
  return new Promise(resolve => {
    if (!square && (file.type === 'image/gif' || file.size < 250 * 1024)) return resolve(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
      if (square) { const side = Math.min(sw, sh); sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side; }
      const scale = Math.min(1, maxSide / Math.max(sw, sh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob && (square || blob.size < file.size) ? blob : file), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(square ? null : file); };
    img.src = url;
  });
}
function sendWithProgress(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentUpload = xhr;
    xhr.open('POST', '/api/media');
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      currentUpload = null;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401 && me) signOut('Votre session a expiré. Reconnectez-vous.');
      if (xhr.status === 413) return reject(new Error(errorText(data, 'Fichier trop volumineux.')));
      reject(new Error(errorText(data, 'Envoi impossible.')));
    };
    xhr.onerror = () => { currentUpload = null; reject(new Error('Connexion au serveur impossible. Vérifiez votre réseau.')); };
    xhr.onabort = () => { currentUpload = null; reject(new Error('Envoi annulé.')); };
    xhr.send(form);
  });
}
function cancelUpload() {
  uploadQueue.length = 0;
  if (currentUpload) currentUpload.abort();
}
$('upload-cancel').onclick = cancelUpload;
function queueUpload(item) {
  uploadQueue.push(item);
  if (uploadQueue.length === 1 && !currentUpload) runUploads();
}
async function runUploads() {
  while (uploadQueue.length) {
    const item = uploadQueue[0];
    const limit = (cfg.max_file_mb && cfg.max_file_mb[item.kind]) || 10;
    let blob = item.file;
    try {
      $('upload-bar').hidden = false;
      $('upload-name').textContent = 'Préparation de ' + (item.name || 'votre fichier') + '…';
      $('upload-fill').style.width = '0%';
      if (item.kind === 'image') blob = await shrinkImage(item.file, 1600, 0.85);
      if (blob.size > limit * 1024 * 1024) throw new Error(KIND_NAMES[item.kind] + ' dépasse ' + limit + ' Mo, la taille maximale.');
      const form = new FormData();
      form.append('kind', item.kind);
      if (item.target.group_id) form.append('group_id', item.target.group_id);
      else form.append('recipient_id', item.target.recipient_id);
      if (item.name) form.append('name', item.name);
      form.append('file', blob, item.name || 'fichier');
      $('upload-name').textContent = 'Envoi de ' + (item.name || 'votre fichier');
      await sendWithProgress(form, ratio => { $('upload-fill').style.width = Math.round(ratio * 100) + '%'; });
      if (selected && item.conv === (selected.type + selected.id)) await fetchNew(true);
    } catch (err) {
      if (err.message !== 'Envoi annulé.') toast(err.message, true);
    }
    uploadQueue.shift();
  }
  $('upload-bar').hidden = true;
  loadConvs();
}
$('attach').onclick = () => $('file-input').click();
$('file-input').onchange = () => {
  const files = Array.prototype.slice.call($('file-input').files || []);
  $('file-input').value = '';
  if (!selected) return;
  files.forEach(file => {
    const kind = kindOf(file);
    if (!kind) return toast('« ' + file.name + ' » n\'est ni une photo, ni une vidéo, ni un fichier audio.', true);
    queueUpload({ kind: kind, file: file, name: file.name, target: targetFields(), conv: selected.type + selected.id });
  });
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
  catch (e) { return toast('Accès au micro refusé. Autorisez-le dans les réglages du navigateur.', true); }
  const target = targetFields(), conv = selected.type + selected.id;
  // AAC/MP4 en premier : c'est le seul format que tous les iPhone savent lire.
  const type = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
    .find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  recordStream = stream;
  recordChunks = [];
  recordDiscard = false;
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const current = recorder;
  current.ondataavailable = e => { if (e.data.size) recordChunks.push(e.data); };
  current.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    const discard = recordDiscard, chunks = recordChunks;
    if (recorder === current) { recorder = null; recordStream = null; }
    clearInterval(recordTimer);
    showRecording(false);
    if (discard || !chunks.length) return;
    const blob = new Blob(chunks, { type: current.mimeType || 'audio/webm' });
    queueUpload({ kind: 'voice', file: blob, name: null, target: target, conv: conv });
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

/* ---------- Blocage ---------- */
async function setBlocked(userId, block) {
  await api('/api/blocks/' + userId, { method: block ? 'POST' : 'DELETE' });
  if (selected && selected.type === 'user' && selected.id === userId) {
    selected.blocked = block;
    refreshHeader();
  }
  renderedSignature = '';
  await loadConvs();
}
$('blocked-unblock').onclick = async () => {
  try { await setBlocked(selected.id, false); toast('Contact débloqué.'); }
  catch (err) { toast(err.message, true); }
};

/* ---------- Infos de la conversation (contact ou groupe) ---------- */
function memberRow(u, extra) {
  const row = el('div', 'member');
  const av = el('span', 'avatar sm');
  paintAvatar(av, u);
  const text = el('div', 'member-text');
  text.appendChild(el('b', '', u.display_name + (me && u.id === me.id ? ' (vous)' : '')));
  text.appendChild(el('span', 'muted', '@' + u.username));
  row.append(av, text);
  if (extra) extra.forEach(node => row.appendChild(node));
  return row;
}
async function openConvInfo() {
  if (!selected) return;
  const body = $('conv-body');
  $('conv-title').textContent = selected.display_name;
  body.replaceChildren(el('p', 'muted', 'Chargement…'));
  $('conv-dialog').showModal();
  if (selected.type === 'user') return renderUserInfo(body);
  try { renderGroupInfo(body, await api('/api/groups/' + selected.id)); }
  catch (err) { body.replaceChildren(el('p', 'error', err.message)); }
}
function renderUserInfo(body) {
  const c = selected;
  const head = el('div', 'profile-card');
  const av = el('span', 'avatar xl');
  paintAvatar(av, c);
  head.append(av, el('b', '', c.display_name), el('span', 'muted', '@' + c.username));
  const btn = el('button', c.blocked ? 'primary' : 'link danger', c.blocked ? 'Débloquer ce contact' : 'Bloquer ce contact');
  btn.type = 'button';
  btn.prepend(icon('i-block'));
  const note = el('p', 'muted', c.blocked
    ? 'Ce contact ne peut pas vous écrire et vous ne voyez pas ses messages dans les groupes.'
    : 'Une fois bloqué, ce contact ne pourra plus vous écrire, et ses messages dans les groupes vous seront masqués. Il n\'en est pas averti.');
  btn.onclick = async () => {
    if (!c.blocked && !window.confirm('Bloquer ' + c.display_name + ' ?')) return;
    btn.disabled = true;
    try {
      await setBlocked(c.id, !c.blocked);
      toast(selected && selected.blocked ? 'Contact bloqué.' : 'Contact débloqué.');
      renderUserInfo(body);
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  };
  body.replaceChildren(head, note, btn);
}
function renderGroupInfo(body, g) {
  const nodes = [];
  if (g.is_admin) {
    const form = el('form', 'inline-form');
    const field = el('input', 'field');
    field.value = g.name;
    field.maxLength = 80;
    field.setAttribute('aria-label', 'Nom du groupe');
    const save = el('button', 'primary', 'Renommer');
    save.type = 'submit';
    form.append(field, save);
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        const updated = await api('/api/groups/' + g.id, { method: 'PATCH', json: { name: field.value } });
        selected.display_name = updated.name;
        $('conv-title').textContent = updated.name;
        refreshHeader();
        renderedSignature = '';
        loadConvs();
        toast('Groupe renommé.');
      } catch (err) { toast(err.message, true); }
    };
    nodes.push(form);
  }
  nodes.push(el('h3', '', g.members.length + ' membres'));
  const list = el('div', 'member-list');
  g.members.forEach(u => {
    const extra = [];
    if (u.is_admin) extra.push(el('span', 'tag', 'Admin'));
    if (g.is_admin && u.id !== me.id) {
      const remove = el('button', 'link danger small', 'Retirer');
      remove.type = 'button';
      remove.onclick = async () => {
        if (!window.confirm('Retirer ' + u.display_name + ' du groupe ?')) return;
        try { renderGroupInfo(body, await api('/api/groups/' + g.id + '/members/' + u.id, { method: 'DELETE' })); }
        catch (err) { toast(err.message, true); }
      };
      extra.push(remove);
    }
    list.appendChild(memberRow(u, extra));
  });
  nodes.push(list);
  const actions = el('div', 'dialog-actions');
  if (g.is_admin) {
    const add = el('button', 'primary', 'Ajouter des membres');
    add.type = 'button';
    add.onclick = () => { $('conv-dialog').close(); openGroupPicker({ mode: 'add', group: g }); };
    actions.appendChild(add);
  }
  const leave = el('button', 'link danger', 'Quitter le groupe');
  leave.type = 'button';
  leave.onclick = async () => {
    if (!window.confirm('Quitter le groupe « ' + g.name + ' » ?')) return;
    try {
      await api('/api/groups/' + g.id + '/members/' + me.id, { method: 'DELETE' });
      $('conv-dialog').close();
      toast('Vous avez quitté le groupe.');
      closeConv();
    } catch (err) { toast(err.message, true); }
  };
  actions.prepend(leave);
  nodes.push(actions);
  body.replaceChildren.apply(body, nodes);
}
$('chat-more').onclick = openConvInfo;
$('chat-title').onclick = openConvInfo;
$('chat-title').onkeydown = e => { if (e.key === 'Enter') openConvInfo(); };

/* ---------- Création de groupe / ajout de membres ---------- */
let picker = null; // { mode: 'create' | 'add', group, picked: Map }
function updatePickCount() {
  const n = picker.picked.size;
  $('group-count').textContent = n ? n + ' membre' + (n > 1 ? 's' : '') + ' choisi' + (n > 1 ? 's' : '') : 'Aucun membre choisi';
}
async function loadPickList() {
  const q = $('group-search').value.trim();
  const box = $('group-pick');
  let rows;
  try { rows = await api('/api/users?q=' + encodeURIComponent(q)); }
  catch (err) { box.replaceChildren(el('p', 'error', err.message)); return; }
  if (!picker || q !== $('group-search').value.trim()) return;
  const existing = picker.group ? picker.group.members.map(m => m.id) : [];
  rows = rows.filter(u => existing.indexOf(u.id) < 0);
  if (!rows.length) { box.replaceChildren(el('p', 'muted', q ? 'Aucun contact trouvé.' : 'Aucun contact à ajouter.')); return; }
  box.replaceChildren.apply(box, rows.map(u => {
    const label = el('label', 'pick');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = picker.picked.has(u.id);
    check.onchange = () => {
      if (check.checked) picker.picked.set(u.id, u); else picker.picked.delete(u.id);
      updatePickCount();
    };
    const row = memberRow(u);
    label.append(check, row);
    return label;
  }));
}
function openGroupPicker(options) {
  picker = { mode: options.mode, group: options.group || null, picked: new Map() };
  const creating = picker.mode === 'create';
  $('group-title').textContent = creating ? 'Nouveau groupe' : 'Ajouter des membres';
  $('group-name-wrap').hidden = !creating;
  $('group-name').value = '';
  $('group-search').value = '';
  $('group-error').textContent = '';
  $('group-submit').textContent = creating ? 'Créer le groupe' : 'Ajouter';
  $('group-pick').replaceChildren(el('p', 'muted', 'Chargement…'));
  updatePickCount();
  $('group-dialog').showModal();
  loadPickList();
  if (creating) $('group-name').focus();
}
$('group-new').onclick = () => openGroupPicker({ mode: 'create' });
let pickTimer = null;
$('group-search').oninput = () => { clearTimeout(pickTimer); pickTimer = setTimeout(loadPickList, 250); };
$('group-form').onsubmit = async e => {
  e.preventDefault();
  const ids = Array.from(picker.picked.keys());
  const fail = msg => { $('group-error').textContent = msg; };
  if (picker.mode === 'create' && !$('group-name').value.trim()) return fail('Donnez un nom au groupe.');
  if (!ids.length) return fail('Choisissez au moins un membre.');
  $('group-submit').disabled = true;
  try {
    if (picker.mode === 'create') {
      const g = await api('/api/groups', { json: { name: $('group-name').value, member_ids: ids } });
      $('group-dialog').close();
      toast('Groupe « ' + g.name + ' » créé.');
      renderedSignature = '';
      await loadConvs();
      openConv({ type: 'group', id: g.id, display_name: g.name, name: g.name, members: g.members.length });
    } else {
      const g = await api('/api/groups/' + picker.group.id + '/members', { json: { user_ids: ids } });
      $('group-dialog').close();
      toast(ids.length > 1 ? 'Membres ajoutés.' : 'Membre ajouté.');
      selected.members = g.members.length;
      refreshHeader();
      loadConvs();
    }
  } catch (err) { fail(err.message); }
  finally { $('group-submit').disabled = false; }
};

/* ---------- Paramètres ---------- */
function openSettings() {
  $('set-display').value = me.display_name;
  $('set-username').value = me.username;
  $('set-phone').value = me.phone || '';
  $('pw-username').value = me.username;
  ['pw-current', 'pw-new', 'pw-confirm'].forEach(id => { $(id).value = ''; });
  $('profile-error').textContent = '';
  $('password-error').textContent = '';
  paintAvatar($('set-avatar'), me);
  $('avatar-remove').hidden = !me.avatar_v;
  $('settings-dialog').showModal();
  loadBlockedList();
}
$('settings-open').onclick = openSettings;
$('me-row').onclick = openSettings;
$('me-row').onkeydown = e => { if (e.key === 'Enter') openSettings(); };

function afterProfileChange(user) {
  me = user;
  showMe();
  paintAvatar($('set-avatar'), me);
  $('avatar-remove').hidden = !me.avatar_v;
  renderedSignature = '';
}
async function uploadAvatar(blob) {
  const form = new FormData();
  form.append('photo', blob, 'photo.jpg');
  try {
    afterProfileChange(await api('/api/me/avatar', { method: 'PUT', body: form }));
    toast('Photo de profil mise à jour.');
  } catch (err) { toast(err.message, true); }
}
$('avatar-pick').onclick = () => $('avatar-input').click();
$('avatar-input').onchange = async () => {
  const file = $('avatar-input').files && $('avatar-input').files[0];
  $('avatar-input').value = '';
  if (!file) return;
  const square = await shrinkImage(file, 320, 0.88, true);
  if (!square) return toast('Cette image ne peut pas être lue. Choisissez une photo JPEG ou PNG.', true);
  uploadAvatar(square);
};
// Photo aléatoire : un motif coloré unique, généré sur le téléphone.
function randomAvatar() {
  const size = 320;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const hue = Math.floor(Math.random() * 360);
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, 'hsl(' + hue + ', 70%, 55%)');
  grad.addColorStop(1, 'hsl(' + ((hue + 60 + Math.random() * 120) % 360) + ', 75%, 45%)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.fillStyle = 'hsla(' + ((hue + Math.random() * 180) % 360) + ', 85%, ' + (55 + Math.random() * 25) + '%, ' + (0.25 + Math.random() * 0.35) + ')';
    ctx.arc(Math.random() * size, Math.random() * size, 30 + Math.random() * 110, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 150px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.25)';
  ctx.shadowBlur = 12;
  ctx.fillText(initial(me.display_name), size / 2, size / 2 + 8);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}
$('avatar-random').onclick = async () => {
  const blob = await randomAvatar();
  if (blob) uploadAvatar(blob);
};
$('avatar-remove').onclick = async () => {
  try { afterProfileChange(await api('/api/me/avatar', { method: 'DELETE' })); toast('Photo retirée.'); }
  catch (err) { toast(err.message, true); }
};
$('profile-form').onsubmit = async e => {
  e.preventDefault();
  const fail = msg => { $('profile-error').textContent = msg; };
  const display = $('set-display').value.trim(), username = $('set-username').value.trim();
  if (!display) return fail('Le nom affiché ne peut pas être vide.');
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return fail('Nom d\'utilisateur : 3 à 40 caractères (lettres, chiffres, point, tiret, souligné).');
  fail('');
  $('profile-save').disabled = true;
  try {
    afterProfileChange(await api('/api/me', { method: 'PATCH', json: { display_name: display, username: username, phone: $('set-phone').value.trim() } }));
    $('set-username').value = me.username;
    $('set-phone').value = me.phone || '';
    toast('Profil enregistré.');
  } catch (err) { fail(err.message); }
  finally { $('profile-save').disabled = false; }
};
$('password-form').onsubmit = async e => {
  e.preventDefault();
  const fail = msg => { $('password-error').textContent = msg; };
  const current = $('pw-current').value, next = $('pw-new').value;
  if (!current) return fail('Saisissez votre mot de passe actuel.');
  if (next.length < 8) return fail('Le nouveau mot de passe doit contenir au moins 8 caractères.');
  if (next !== $('pw-confirm').value) return fail('Les deux nouveaux mots de passe ne sont pas identiques.');
  fail('');
  $('password-save').disabled = true;
  try {
    const data = await api('/api/me/password', { json: { current_password: current, new_password: next } });
    setToken(data.token);
    ['pw-current', 'pw-new', 'pw-confirm'].forEach(id => { $(id).value = ''; });
    toast('Mot de passe modifié. Vos autres appareils ont été déconnectés.');
  } catch (err) { fail(err.message); }
  finally { $('password-save').disabled = false; }
};
async function loadBlockedList() {
  const box = $('blocked-list');
  box.replaceChildren(el('p', 'muted', 'Chargement…'));
  try {
    const rows = await api('/api/blocks');
    if (!rows.length) { box.replaceChildren(el('p', 'muted', 'Aucun contact bloqué.')); return; }
    box.replaceChildren.apply(box, rows.map(u => {
      const unblock = el('button', 'link small', 'Débloquer');
      unblock.type = 'button';
      unblock.onclick = async () => {
        try { await setBlocked(u.id, false); toast(u.display_name + ' est débloqué.'); loadBlockedList(); }
        catch (err) { toast(err.message, true); }
      };
      return memberRow(u, [unblock]);
    }));
  } catch (err) { box.replaceChildren(el('p', 'error', err.message)); }
}

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

/* ---------- Animation de démarrage ---------- */
(function () {
  const splash = $('splash');
  if (!splash) return;
  const remove = () => { if (splash.parentNode) splash.parentNode.removeChild(splash); };
  splash.addEventListener('animationend', e => { if (e.target === splash) remove(); });
  setTimeout(remove, 3400); // sécurité si l'événement de fin n'arrive pas (onglet en arrière-plan…)
  // Toucher l'écran passe l'animation.
  splash.addEventListener('click', () => {
    splash.style.transition = 'opacity .25s';
    splash.style.opacity = '0';
    setTimeout(remove, 260);
  });
  if (document.documentElement.className.indexOf('splash-seen') >= 0) remove();
})();

/* ---------- Démarrage ---------- */
applyAuthMode();
if (token) start(); else $('auth').hidden = false;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
