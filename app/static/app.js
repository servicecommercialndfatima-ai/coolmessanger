'use strict';
// Écrit sans syntaxe trop récente (pas de « ?. » ni « ?? ») pour fonctionner sur les iPhone depuis iOS 12.
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'cm_token';
const MAX_RECORD_SECONDS = 300;

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
let me = null;             // mon compte, avec mes profils par rubrique
let cfg = { max_file_mb: { voice: 12, audio: 15, image: 8, video: 20 }, sectors: [], report_reasons: {}, push_key: '' };
let space = null;          // rubrique affichée : business | amour | gbairai
let section = 'chats';     // chats | discover | requests | posts
let selected = null;       // conversation ouverte : { type: 'user' | 'group', id, display_name, ... }
let convs = [], directoryRows = [];
let lastId = 0, lastDay = '', lastSender = null;
let pollTimer = null, pollBusy = false, tick = 0;
let recorder = null, recordStream = null, recordChunks = [], recordTimer = null, recordStart = 0, recordDiscard = false;
let unreadState = null;    // derniers compteurs connus, pour savoir quand sonner
const mediaCache = new Map();
const avatarCache = new Map();

const SPACE_META = {
  business: { label: 'Business', emoji: '💼', color: '#1c6dd0',
    pitch: 'Présentez votre entreprise, publiez vos offres et trouvez de nouveaux partenaires d\'affaires.',
    points: ['Fiche entreprise : nom, secteur, activités', 'Annuaire des entreprises par secteur', 'Publications et annonces', 'Contact direct entre professionnels'] },
  amour: { label: 'Amour', emoji: '❤️', color: '#e0245e',
    pitch: 'Faites des rencontres en toute discrétion, entre personnes majeures.',
    points: ['Réservé aux 18 ans et plus', 'Profils compatibles avec ce que vous recherchez', 'On discute seulement après une demande acceptée', 'Invisible pour Business et Gbairai'] },
  gbairai: { label: 'Gbairai', emoji: '💬', color: '#e8590c',
    pitch: 'L\'espace pour discuter librement et vous faire de nouveaux amis.',
    points: ['Découvrez les profils des membres', 'Envoyez une demande à qui vous voulez', 'Messages privés et groupes', 'Photos, vidéos et vocaux'] },
};
const SPACE_ORDER = ['business', 'amour', 'gbairai'];

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
function btn(className, text, onclick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onclick) b.onclick = onclick;
  return b;
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
function pref(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } }
function setPref(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
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
  if ((res.status === 401 || res.status === 403) && me && /^\/api\/me$/.test(path)) { signOut('Votre session a expiré. Reconnectez-vous.'); throw new Error('Session expirée.'); }
  if (res.status === 401 && me) { signOut('Votre session a expiré. Reconnectez-vous.'); throw new Error('Session expirée.'); }
  if (opts.blob && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && /^Compte suspendu/.test(errorText(data, ''))) signOut(data.detail);
    throw new Error(errorText(data, 'Une erreur est survenue.'));
  }
  return data;
}
function sp(path) { return '/api/s/' + space + path; }
function initial(name) { return (Array.from(String(name || '').trim())[0] || '?').toUpperCase(); }
function hueOf(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function loadAvatar(pid, version) {
  const key = pid + ':' + version;
  if (!avatarCache.has(key)) {
    avatarCache.set(key, api('/api/p/' + pid + '/avatar', { blob: true })
      .then(blob => URL.createObjectURL(blob)).catch(() => null));
  }
  return avatarCache.get(key);
}
// Pastille ronde : photo du profil si elle existe, sinon l'initiale sur un fond coloré.
function paintAvatar(node, who) {
  const isGroup = who.type === 'group';
  const pid = isGroup ? null : (who.pid || who.id);
  node.classList.toggle('group', isGroup);
  node.style.setProperty('--h', hueOf(isGroup ? 'g' + who.id + who.display_name : 'p' + pid + who.display_name));
  node.textContent = initial(who.display_name);
  const version = !isGroup && who.avatar_v;
  const key = version ? pid + ':' + version : '';
  node.dataset.av = key;
  if (!version) return;
  loadAvatar(pid, version).then(url => {
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
const longFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
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
function targetFields() { return selected.type === 'group' ? { group_id: selected.id } : { to_pid: selected.id }; }
function historyUrl(c, after) {
  const base = c.type === 'group' ? '/api/groups/' + c.id + '/messages' : sp('/messages/' + c.id);
  return base + '?after=' + (after || 0);
}
function myProfile() { return me && space ? me.profiles[space] : null; }
document.querySelectorAll('dialog').forEach(d => {
  const close = d.querySelector('.dlg-close');
  if (close) close.onclick = () => d.close();
  d.addEventListener('click', e => { if (e.target === d && d.classList.contains('wide')) d.close(); });
});

/* ---------- Sons de notification (fabriqués par l'application, aucun fichier à télécharger) ---------- */
const SOUNDS = {
  bip: { label: 'Bip', notes: [[880, 0, 0.12, 'square', 0.12]] },
  double: { label: 'Double bip', notes: [[988, 0, 0.09, 'square', 0.1], [988, 0.16, 0.09, 'square', 0.1]] },
  carillon: { label: 'Carillon', notes: [[1047, 0, 0.5, 'sine', 0.3], [1319, 0.12, 0.5, 'sine', 0.28], [1568, 0.24, 0.7, 'sine', 0.26]] },
  marimba: { label: 'Marimba', notes: [[784, 0, 0.25, 'triangle', 0.4], [988, 0.11, 0.25, 'triangle', 0.4], [1175, 0.22, 0.4, 'triangle', 0.4]] },
  melodie: { label: 'Petite mélodie', notes: [[523, 0, 0.18, 'triangle', 0.35], [659, 0.15, 0.18, 'triangle', 0.35], [784, 0.3, 0.18, 'triangle', 0.35], [1047, 0.45, 0.45, 'triangle', 0.35], [784, 0.7, 0.4, 'triangle', 0.25]] },
  goutte: { label: 'Goutte d\'eau', notes: [[1400, 0, 0.15, 'sine', 0.35, 600]] },
  aucun: { label: 'Aucun son', notes: [] },
};
let audioCtx = null;
function unlockAudio() {
  // Les navigateurs n'autorisent le son qu'après un premier geste de la personne.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}
document.addEventListener('pointerdown', unlockAudio, { passive: true });
document.addEventListener('touchstart', unlockAudio, { passive: true });
document.addEventListener('keydown', unlockAudio);
let lastSoundAt = 0;
function playSound(name, force) {
  const now = Date.now();
  if (!force && now - lastSoundAt < 1500) return;
  lastSoundAt = now;
  const sound = SOUNDS[name || pref('cm_sound', 'carillon')] || SOUNDS.carillon;
  if (pref('cm_vibrate', '1') === '1' && navigator.vibrate && sound.notes.length && !force) navigator.vibrate([120, 60, 120]);
  if (!audioCtx || !sound.notes.length) return;
  try {
    const t0 = audioCtx.currentTime + 0.02;
    sound.notes.forEach(n => {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = n[3];
      osc.frequency.setValueAtTime(n[0], t0 + n[1]);
      if (n[5]) osc.frequency.exponentialRampToValueAtTime(n[5], t0 + n[1] + n[2]);
      gain.gain.setValueAtTime(0.0001, t0 + n[1]);
      gain.gain.exponentialRampToValueAtTime(n[4], t0 + n[1] + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0 + n[1]);
      osc.stop(t0 + n[1] + n[2] + 0.05);
    });
  } catch (e) {}
}
// Titre de l'onglet qui clignote quand un message arrive alors qu'on regarde ailleurs.
let titleBlink = null;
function blinkTitle(text) {
  if (!document.hidden) return;
  clearInterval(titleBlink);
  let on = false;
  titleBlink = setInterval(() => { on = !on; document.title = on ? text : baseTitle; }, 1000);
}
let baseTitle = 'COOL MESSENGER';
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { clearInterval(titleBlink); document.title = baseTitle; }
});

/* ---------- Formulaires de profil (inscription, paramètres, nouvelle rubrique) ---------- */
const PROFILE_FIELDS = {
  business: [
    ['company', 'Nom de l\'entreprise', 'text', true, 120, 'Ex. Pharma Plus'],
    ['sector', 'Secteur d\'activité', 'sector', true],
    ['display_name', 'Votre nom (personne à contacter)', 'text', true, 80, 'Ex. Awa Koné'],
    ['activities', 'Activités', 'textarea', false, 600, 'Ce que vous vendez ou proposez'],
    ['city', 'Ville', 'text', false, 80, 'Ex. Yamoussoukro'],
    ['website', 'Site internet', 'url', false, 200, 'https://'],
    ['bio', 'Présentation', 'textarea', false, 600, 'Votre histoire, vos valeurs, ce que vous recherchez comme partenaires'],
  ],
  amour: [
    ['display_name', 'Nom de profil', 'text', true, 80, 'Le nom que verront les autres'],
    ['sex', 'Je suis', 'sex', true],
    ['seeking', 'Je recherche', 'seeking', true],
    ['birth_date', 'Date de naissance', 'date', true],
    ['city', 'Ville', 'text', false, 80, 'Ex. Abidjan'],
    ['bio', 'Biographie', 'textarea', false, 600, 'Parlez un peu de vous'],
  ],
  gbairai: [
    ['display_name', 'Nom de profil', 'text', true, 80, 'Le nom que verront les autres'],
    ['city', 'Ville', 'text', false, 80, 'Ex. Bouaké'],
    ['bio', 'Biographie', 'textarea', false, 600, 'Vos passions, ce que vous aimez'],
  ],
};
let formSeq = 0;
function choiceRow(name, value, options) {
  const row = el('div', 'choice-row');
  options.forEach(o => {
    const label = el('label', 'choice');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = o[0];
    input.checked = value === o[0];
    label.append(input, el('span', '', o[1]));
    row.appendChild(label);
  });
  return row;
}
// Construit le formulaire d'une rubrique ; renvoie le bloc, une fonction de lecture et une de vérification.
function profileForm(spaceName, values) {
  values = values || {};
  const seq = ++formSeq;
  const box = el('div', 'profile-form');
  const inputs = {};
  if (spaceName === 'amour') box.appendChild(el('p', 'note', 'Réservé aux 18 ans et plus. Seul votre âge est affiché, jamais votre date de naissance.'));
  PROFILE_FIELDS[spaceName].forEach(f => {
    const id = 'pf' + seq + '-' + f[0];
    const label = el('label', '', f[1]);
    label.htmlFor = id;
    if (!f[3]) label.appendChild(el('span', 'muted', ' (facultatif)'));
    box.appendChild(label);
    let input;
    if (f[2] === 'textarea') {
      input = el('textarea', 'field');
      input.rows = 3;
    } else if (f[2] === 'sector') {
      input = el('select', 'field');
      input.appendChild(el('option', '', 'Choisissez un secteur'));
      input.firstChild.value = '';
      (cfg.sectors || []).forEach(s => { const o = el('option', '', s); o.value = s; input.appendChild(o); });
    } else if (f[2] === 'sex') {
      input = choiceRow(id, values.sex, [['homme', 'Un homme'], ['femme', 'Une femme']]);
    } else if (f[2] === 'seeking') {
      input = choiceRow(id, values.seeking, [['femme', 'Une femme'], ['homme', 'Un homme'], ['les2', 'Les deux']]);
    } else {
      input = el('input', 'field');
      input.type = f[2] === 'url' ? 'url' : f[2] === 'date' ? 'date' : 'text';
      if (f[2] === 'date') {
        const max = new Date();
        max.setFullYear(max.getFullYear() - 18);
        input.max = max.toISOString().slice(0, 10);
        input.min = '1920-01-01';
      }
    }
    if (input.tagName !== 'DIV') {
      input.id = id;
      if (f[4]) input.maxLength = f[4];
      if (f[5]) input.placeholder = f[5];
      if (values[f[0]] != null) input.value = values[f[0]];
    }
    inputs[f[0]] = input;
    box.appendChild(input);
  });
  function read() {
    const out = {};
    PROFILE_FIELDS[spaceName].forEach(f => {
      const input = inputs[f[0]];
      if (input.tagName === 'DIV') {
        const checked = input.querySelector('input:checked');
        out[f[0]] = checked ? checked.value : null;
      } else {
        out[f[0]] = input.value.trim() || null;
      }
    });
    return out;
  }
  function validate() {
    const v = read();
    const label = SPACE_META[spaceName].label + ' : ';
    for (const f of PROFILE_FIELDS[spaceName]) {
      if (f[3] && !v[f[0]]) return label + 'remplissez « ' + f[1] + ' ».';
    }
    if (spaceName === 'amour' && v.birth_date) {
      const b = new Date(v.birth_date + 'T00:00:00'), now = new Date();
      let age = now.getFullYear() - b.getFullYear();
      if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
      if (!(age >= 18)) return 'La rubrique Amour est réservée aux personnes de 18 ans et plus.';
    }
    if (v.website && !/^https?:\/\/\S+\.\S+/i.test(v.website)) return label + 'le site internet doit commencer par http:// ou https://.';
    return '';
  }
  return { node: box, read: read, validate: validate };
}

/* ---------- Connexion ---------- */
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
  fail('');
  $('auth-submit').disabled = true;
  try {
    const data = await api('/api/login', { json: { username: username, password: password } });
    setToken(data.token);
    $('password').value = '';
    await start();
  } catch (err) { fail(err.message); }
  finally { $('auth-submit').disabled = false; }
};
function showLogin(message) {
  $('auth').hidden = false;
  $('login-card').hidden = false;
  $('wizard').hidden = true;
  $('auth-error').textContent = message || '';
}
$('toggle').onclick = () => openWizard('register');
$('wiz-to-login').onclick = () => showLogin();

/* ---------- Inscription et choix des rubriques, étape par étape ---------- */
let wiz = null;
function openWizard(mode) {
  wiz = { mode: mode, step: 0, chosen: [], forms: {}, values: {}, account: {} };
  if (mode === 'onboard') wiz.chosen = (me.spaces || []).slice();
  $('auth').hidden = false;
  $('login-card').hidden = true;
  $('wizard').hidden = false;
  $('wiz-login').hidden = mode !== 'register';
  renderWizard();
}
function wizardSteps() {
  const steps = ['intro'];
  wiz.chosen.forEach(s => { if (!(wiz.mode === 'onboard' && me.profiles[s])) steps.push(s); });
  steps.push(wiz.mode === 'register' ? 'account' : 'terms');
  return steps;
}
function termsCheck() {
  const label = el('label', 'check terms');
  const box = el('input');
  box.type = 'checkbox';
  box.id = 'wiz-terms';
  box.checked = !!wiz.account.terms;
  box.onchange = () => { wiz.account.terms = box.checked; };
  const link = el('a', 'link', 'conditions d\'utilisation et la politique de confidentialité');
  link.href = '/conditions';
  link.target = '_blank';
  link.rel = 'noopener';
  label.append(box, document.createTextNode(' J\'ai lu et j\'accepte les '), link, document.createTextNode('.'));
  return label;
}
function renderWizard() {
  const steps = wizardSteps();
  if (wiz.step >= steps.length) wiz.step = steps.length - 1;
  const step = steps[wiz.step];
  const body = $('wiz-body');
  $('wiz-error').textContent = '';
  $('wiz-back').style.visibility = wiz.step === 0 ? 'hidden' : 'visible';
  $('wiz-dots').replaceChildren.apply($('wiz-dots'), steps.map((s, i) => el('span', 'wiz-dot' + (i === wiz.step ? ' on' : i < wiz.step ? ' done' : ''))));
  const nodes = [];
  if (step === 'intro') {
    nodes.push(el('h1', '', wiz.mode === 'register' ? 'Choisissez vos rubriques' : 'Nouveau : les rubriques'));
    nodes.push(el('p', 'muted center', wiz.mode === 'register'
      ? 'COOL MESSENGER, ce sont trois espaces indépendants. Choisissez-en un, deux ou les trois : vous aurez un profil distinct dans chacun.'
      : 'COOL MESSENGER est maintenant organisé en trois espaces indépendants. Vos conversations actuelles sont dans Gbairai. Vous pouvez en rejoindre d\'autres.'));
    SPACE_ORDER.forEach(s => {
      const meta = SPACE_META[s];
      const already = wiz.mode === 'onboard' && me.profiles[s];
      const cardNode = el('label', 'space-card' + (wiz.chosen.indexOf(s) >= 0 ? ' chosen' : ''));
      cardNode.dataset.space = s;
      const check = el('input');
      check.type = 'checkbox';
      check.checked = wiz.chosen.indexOf(s) >= 0;
      check.disabled = !!already;
      check.onchange = () => {
        if (check.checked) { if (wiz.chosen.indexOf(s) < 0) wiz.chosen.push(s); }
        else wiz.chosen = wiz.chosen.filter(x => x !== s);
        wiz.chosen.sort((a, b) => SPACE_ORDER.indexOf(a) - SPACE_ORDER.indexOf(b));
        cardNode.classList.toggle('chosen', check.checked);
      };
      const head = el('div', 'space-card-head');
      head.append(el('span', 'space-emoji', meta.emoji), el('b', '', meta.label), el('span', 'space-check', already ? 'Déjà membre' : ''));
      const list = el('ul');
      meta.points.forEach(p => list.appendChild(el('li', '', p)));
      cardNode.append(check, head, el('p', '', meta.pitch), list);
      nodes.push(cardNode);
    });
  } else if (SPACE_META[step]) {
    const meta = SPACE_META[step];
    const title = el('h1', 'space-title');
    title.append(el('span', 'space-emoji', meta.emoji), document.createTextNode(' Profil ' + meta.label));
    nodes.push(title, el('p', 'muted center', step === 'business' ? 'Ce profil présente votre entreprise aux autres membres Business.'
      : step === 'amour' ? 'Ce profil n\'est visible que des membres d\'Amour.' : 'Ce profil n\'est visible que des membres de Gbairai.'));
    if (!wiz.forms[step]) wiz.forms[step] = profileForm(step, wiz.values[step]);
    nodes.push(wiz.forms[step].node);
  } else if (step === 'account') {
    nodes.push(el('h1', '', 'Votre compte'), el('p', 'muted center', 'Votre identifiant et votre mot de passe servent à vous connecter. Ils ne sont jamais montrés aux autres membres.'));
    const fields = [['wiz-username', 'Nom d\'utilisateur', 'text', 'username', 'Ex. awa.kone', 40],
                    ['wiz-password', 'Mot de passe', 'password', 'new-password', '8 caractères minimum', 128],
                    ['wiz-phone', 'Téléphone (facultatif, reste privé)', 'tel', 'tel', '+225 07 00 00 00 00', 30]];
    fields.forEach(f => {
      const label = el('label', '', f[1]);
      label.htmlFor = f[0];
      const input = el('input', 'field');
      input.id = f[0];
      input.type = f[2];
      input.autocomplete = f[3];
      input.placeholder = f[4];
      input.maxLength = f[5];
      input.value = wiz.account[f[0]] || '';
      if (f[0] === 'wiz-username') { input.autocapitalize = 'none'; input.spellcheck = false; }
      input.oninput = () => { wiz.account[f[0]] = input.value; };
      nodes.push(label, input);
    });
    nodes.push(termsCheck());
  } else if (step === 'terms') {
    nodes.push(el('h1', '', 'Dernière étape'), el('p', 'muted center', 'Pour continuer, acceptez les règles de la communauté.'));
    nodes.push(termsCheck());
  }
  body.replaceChildren.apply(body, nodes);
  $('wiz-next').textContent = step === 'account' ? 'Créer mon compte' : step === 'terms' ? 'Terminer' : 'Continuer';
}
$('wiz-back').onclick = () => {
  if (!wiz || wiz.step === 0) return;
  const step = wizardSteps()[wiz.step];
  if (wiz.forms[step]) wiz.values[step] = wiz.forms[step].read();
  wiz.step--;
  renderWizard();
};
$('wiz-next').onclick = async () => {
  const steps = wizardSteps();
  const step = steps[wiz.step];
  const fail = msg => { $('wiz-error').textContent = msg; };
  if (step === 'intro') {
    const fresh = wiz.chosen.filter(s => !(wiz.mode === 'onboard' && me.profiles[s]));
    if (!wiz.chosen.length) return fail('Choisissez au moins une rubrique.');
    if (wiz.mode === 'register' && !fresh.length) return fail('Choisissez au moins une rubrique.');
  } else if (wiz.forms[step]) {
    const problem = wiz.forms[step].validate();
    if (problem) return fail(problem);
    wiz.values[step] = wiz.forms[step].read();
  } else if (step === 'account' || step === 'terms') {
    const profiles = {};
    wiz.chosen.forEach(s => { if (wiz.forms[s]) profiles[s] = wiz.forms[s].read(); });
    if (!wiz.account.terms) return fail('Acceptez les conditions d\'utilisation pour continuer.');
    $('wiz-next').disabled = true;
    try {
      if (step === 'account') {
        const username = (wiz.account['wiz-username'] || '').trim(), password = wiz.account['wiz-password'] || '';
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error('Nom d\'utilisateur : 3 à 40 caractères (lettres, chiffres, point, tiret, souligné).');
        if (password.length < 8) throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
        const data = await api('/api/register', { json: { username: username, password: password, phone: (wiz.account['wiz-phone'] || '').trim() || null, accept_terms: true, profiles: profiles } });
        setToken(data.token);
      } else {
        me = await api('/api/me/onboarding', { json: { accept_terms: true, profiles: profiles } });
      }
      wiz = null;
      await start();
    } catch (err) { fail(err.message); }
    finally { $('wiz-next').disabled = false; }
    return;
  }
  wiz.step++;
  renderWizard();
};

/* ---------- Démarrage de la session ---------- */
function signOut(message) {
  setToken(null);
  clearInterval(pollTimer);
  stopRecording(true);
  cancelUpload();
  mediaCache.forEach(p => p.then(url => { if (url) URL.revokeObjectURL(url); }).catch(() => {}));
  mediaCache.clear();
  avatarCache.clear();
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  me = null; selected = null; convs = []; unreadState = null; renderedSignature = '';
  $('app').hidden = true;
  $('app').classList.remove('chat-open');
  showPane('placeholder');
  $('messages').replaceChildren();
  $('contacts').replaceChildren();
  baseTitle = 'COOL MESSENGER';
  document.title = baseTitle;
  showLogin(message);
}
$('logout').onclick = () => signOut();

async function start() {
  try { me = await api('/api/me'); }
  catch (e) { setToken(null); showLogin(e.message === 'Session expirée.' ? '' : e.message); return; }
  if (!me.onboarded || !me.spaces.length) { openWizard('onboard'); return; }
  $('auth').hidden = true;
  $('app').hidden = false;
  $('admin-open').hidden = !me.is_admin;
  $('sms-open').hidden = !cfg.sms_enabled;
  const sectorFilter = $('filter-sector');
  if (sectorFilter.options.length < 2) {
    (cfg.sectors || []).forEach(s => { const o = el('option', '', s); o.value = s; sectorFilter.appendChild(o); });
  }
  renderSpaceTabs();
  const wanted = pref('cm_space', me.spaces[0]);
  setSpace(me.spaces.indexOf(wanted) >= 0 ? wanted : me.spaces[0]);
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 3000);
  refreshUnread(true);
  refreshNotifCard();
  if (me.is_admin) refreshAdminBadge();
  const params = new URLSearchParams(location.search);
  if (params.get('open')) { handleOpen(params.get('open')); history.replaceState(null, '', '/'); }
}

/* ---------- Rubriques ---------- */
function renderSpaceTabs() {
  const box = $('space-tabs');
  const nodes = me.spaces.map(s => {
    const meta = SPACE_META[s];
    const tab = btn('space-tab' + (s === space ? ' active' : ''), '', () => { if (s !== space) setSpace(s); });
    tab.dataset.space = s;
    tab.append(el('span', 'space-emoji', meta.emoji), el('span', 'space-name', meta.label));
    const count = unreadState && unreadState[s] ? unreadState[s].messages + unreadState[s].requests : 0;
    if (count && s !== space) tab.appendChild(el('span', 'badge', count > 99 ? '99+' : String(count)));
    return tab;
  });
  if (me.spaces.length < 3) {
    const join = btn('space-tab join', '', openJoin);
    join.title = 'Rejoindre une autre rubrique';
    join.append(icon('i-plus'), el('span', 'space-name', 'Rejoindre'));
    nodes.push(join);
  }
  box.replaceChildren.apply(box, nodes);
}
function setSpace(s) {
  space = s;
  setPref('cm_space', s);
  document.documentElement.dataset.space = s;
  stopRecording(true);
  selected = null;
  $('app').classList.remove('chat-open');
  renderSpaceTabs();
  renderMe();
  renderSectionTabs();
  setSection('chats');
}
function renderMe() {
  const p = myProfile();
  $('me-name').textContent = p.display_name;
  $('me-sub').textContent = SPACE_META[space].label + (p.company ? ' · ' + p.company : '') + ' · modifier mon profil';
  paintAvatar($('me-avatar'), p);
}
function sectionsFor(s) {
  const list = [['chats', 'Discussions', 'i-chat'], ['discover', s === 'business' ? 'Annuaire' : 'Découvrir', 'i-compass']];
  if (s === 'business') list.push(['posts', 'Publications', 'i-news']);
  else list.push(['requests', 'Demandes', 'i-inbox']);
  return list;
}
function renderSectionTabs() {
  const box = $('section-tabs');
  box.replaceChildren.apply(box, sectionsFor(space).map(item => {
    const tab = btn('tab' + (item[0] === section ? ' active' : ''), '', () => setSection(item[0]));
    tab.dataset.section = item[0];
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(item[0] === section));
    tab.append(icon(item[2]), el('span', '', item[1]));
    const st = unreadState && unreadState[space];
    const count = !st ? 0 : item[0] === 'chats' ? st.messages : item[0] === 'requests' ? st.requests : 0;
    if (count) tab.appendChild(el('span', 'badge', count > 99 ? '99+' : String(count)));
    return tab;
  }));
}
function setSection(name) {
  if (!sectionsFor(space).some(item => item[0] === name)) name = 'chats';
  section = name;
  renderedSignature = '';
  renderSectionTabs();
  $('search').value = '';
  $('search').placeholder = name === 'chats' ? 'Rechercher une conversation' : name === 'discover'
    ? (space === 'business' ? 'Entreprise, activité, produit…' : 'Rechercher un profil') : 'Rechercher';
  $('search').parentNode.hidden = name === 'requests' || name === 'posts';
  $('filters').hidden = name !== 'discover';
  $('filter-sector').hidden = space !== 'business';
  $('group-new').hidden = name !== 'chats';
  $('contacts').replaceChildren(el('div', 'list-note', 'Chargement…'));
  if (name === 'posts') {
    $('contacts').replaceChildren(postsHint());
    openFeed();
  } else if (!selected) {
    showPane('placeholder');
  }
  loadList();
}
function postsHint() {
  const box = el('div', 'list-note');
  box.append(el('b', '', 'Publications Business'), el('br'), document.createTextNode('Les annonces des entreprises s\'affichent à droite. Publiez les vôtres pour vous faire connaître.'));
  const open = btn('primary small-btn', 'Voir les publications', openFeed);
  box.append(el('br'), open);
  return box;
}
function showPane(name) {
  $('placeholder').hidden = name !== 'placeholder';
  $('feed').hidden = name !== 'feed';
  $('chat-inner').hidden = name !== 'chat';
  if (name === 'placeholder') {
    const meta = SPACE_META[space] || SPACE_META.gbairai;
    $('placeholder-emblem').textContent = meta.emoji;
    $('placeholder-title').textContent = meta.label;
    $('placeholder-text').textContent = meta.pitch;
  }
}
async function loadList() {
  const wanted = space + section;
  try {
    if (section === 'chats') {
      const rows = await api(sp('/conversations?q=' + encodeURIComponent($('search').value.trim())));
      if (wanted !== space + section) return;
      convs = rows;
      if (selected) {
        const fresh = convs.find(isSelected);
        if (fresh) { Object.assign(selected, fresh); refreshHeader(); }
      }
      renderChats();
    } else if (section === 'discover') {
      const q = '?q=' + encodeURIComponent($('search').value.trim()) + '&city=' + encodeURIComponent($('filter-city').value.trim())
        + (space === 'business' ? '&sector=' + encodeURIComponent($('filter-sector').value) : '');
      const rows = await api(sp('/directory' + q));
      if (wanted !== space + section) return;
      directoryRows = rows;
      renderDirectory();
    } else if (section === 'requests') {
      const data = await api(sp('/requests'));
      if (wanted !== space + section) return;
      renderRequests(data);
    }
  } catch (err) {
    if (wanted === space + section && !$('contacts').querySelector('.contact, .request')) $('contacts').replaceChildren(el('div', 'list-note', err.message));
  }
}
let searchTimer = null;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 300); };
$('filter-city').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 400); };
$('filter-sector').onchange = loadList;
$('me-row').onclick = () => openSettings();
$('me-row').onkeydown = e => { if (e.key === 'Enter') openSettings(); };

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


/* ---------- Listes : discussions, annuaire, demandes ---------- */
let renderedSignature = '';
function previewText(c) {
  if (c.unavailable) return 'Compte indisponible';
  if (c.blocked) return 'Contact bloqué';
  if (!c.last) return c.type === 'group' ? c.members + ' membres' : (space === 'business' ? (c.subtitle || 'Nouvelle conversation') : 'Vous êtes en contact. Dites bonjour !');
  let who = '';
  if (c.last.mine) who = 'Vous : ';
  else if (c.type === 'group' && c.last.sender_name) who = c.last.sender_name.split(' ')[0] + ' : ';
  return who + c.last.body;
}
function renderChats() {
  const q = $('search').value.trim();
  const signature = JSON.stringify([space, convs, selected && selected.type + selected.id, q, dayKey(new Date())]);
  if (signature === renderedSignature && $('contacts').childElementCount) return;
  renderedSignature = signature;
  const nodes = convs.map(c => {
    const unread = isSelected(c) ? 0 : c.unread;
    const row = btn('contact' + (isSelected(c) ? ' active' : '') + (unread ? ' unread' : '') + (c.blocked ? ' blocked' : ''), '', () => openConv(c));
    const av = el('span', 'avatar');
    paintAvatar(av, c);
    const main = el('div', 'contact-main');
    const top = el('div', 'contact-top');
    const name = el('span', 'contact-name', c.display_name);
    if (c.type === 'group') name.prepend(icon('i-group'));
    top.appendChild(name);
    if (c.last) top.appendChild(el('span', 'contact-time', shortTime(new Date(c.last.created_at))));
    const bottom = el('div', 'contact-bottom');
    bottom.appendChild(el('span', 'contact-sub', previewText(c)));
    if (unread) bottom.appendChild(el('span', 'badge', unread > 99 ? '99+' : String(unread)));
    main.append(top, bottom);
    row.append(av, main);
    return row;
  });
  if (!nodes.length) {
    const note = el('div', 'list-note');
    note.appendChild(document.createTextNode(q ? 'Aucune conversation ne correspond à cette recherche.'
      : space === 'business' ? 'Aucune conversation pour l\'instant. Parcourez l\'annuaire pour contacter des entreprises.'
      : 'Aucune conversation pour l\'instant. Découvrez les profils et envoyez une demande à ceux qui vous plaisent.'));
    if (!q) { note.appendChild(el('br')); note.appendChild(btn('primary small-btn', space === 'business' ? 'Ouvrir l\'annuaire' : 'Découvrir les profils', () => setSection('discover'))); }
    nodes.push(note);
  }
  $('contacts').replaceChildren.apply($('contacts'), nodes);
}
const RELATION_LABELS = { connected: 'En contact', pending_out: 'Demande envoyée', pending_in: 'Vous a fait une demande', declined_in: 'Demande refusée', blocked: 'Bloqué' };
function renderDirectory() {
  const nodes = directoryRows.map(p => {
    const row = btn('contact profile-row', '', () => openProfile(p.pid));
    const av = el('span', 'avatar');
    paintAvatar(av, p);
    const main = el('div', 'contact-main');
    const top = el('div', 'contact-top');
    top.appendChild(el('span', 'contact-name', space === 'business' && p.subtitle ? p.subtitle.split(' · ')[0] : p.display_name));
    if (RELATION_LABELS[p.relation]) top.appendChild(el('span', 'tag rel-' + p.relation, RELATION_LABELS[p.relation]));
    main.appendChild(top);
    const sub = space === 'business' ? [p.display_name, (p.subtitle || '').split(' · ')[1], p.city].filter(Boolean).join(' · ') : p.subtitle;
    if (sub) main.appendChild(el('div', 'contact-sub strong', sub));
    if (p.bio) main.appendChild(el('div', 'contact-sub', p.bio));
    row.append(av, main);
    return row;
  });
  if (!nodes.length) {
    nodes.push(el('div', 'list-note', space === 'amour'
      ? 'Aucun profil compatible pour le moment. Revenez bientôt : de nouveaux membres s\'inscrivent chaque jour.'
      : 'Aucun membre ne correspond à cette recherche pour le moment.'));
  }
  $('contacts').replaceChildren.apply($('contacts'), nodes);
}
function renderRequests(data) {
  const nodes = [];
  nodes.push(el('h4', 'list-title', 'Demandes reçues' + (data.incoming.length ? ' (' + data.incoming.length + ')' : '')));
  if (!data.incoming.length) nodes.push(el('div', 'list-note small', 'Aucune demande en attente.'));
  data.incoming.forEach(r => {
    const box = el('div', 'request');
    const head = btn('request-head', '', () => openProfile(r.profile.pid));
    const av = el('span', 'avatar');
    paintAvatar(av, r.profile);
    const text = el('div', 'contact-main');
    text.append(el('span', 'contact-name', r.profile.display_name), el('span', 'contact-sub', r.profile.subtitle || 'Voir le profil'));
    head.append(av, text);
    box.appendChild(head);
    if (r.message) box.appendChild(el('p', 'request-msg', '« ' + r.message + ' »'));
    const actions = el('div', 'request-actions');
    actions.append(
      btn('link', 'Refuser', async () => { try { await api('/api/requests/' + r.id + '/decline', { method: 'POST' }); toast('Demande refusée. La personne n\'en est pas informée.'); loadList(); refreshUnread(); } catch (err) { toast(err.message, true); } }),
      btn('primary', 'Accepter', async () => {
        try {
          await api('/api/requests/' + r.id + '/accept', { method: 'POST' });
          toast('Vous êtes maintenant en contact avec ' + r.profile.display_name + '.');
          refreshUnread();
          setSection('chats');
          openConv({ type: 'user', id: r.profile.pid, pid: r.profile.pid, display_name: r.profile.display_name, avatar_v: r.profile.avatar_v, subtitle: r.profile.subtitle });
        } catch (err) { toast(err.message, true); }
      }));
    box.appendChild(actions);
    nodes.push(box);
  });
  nodes.push(el('h4', 'list-title', 'Demandes envoyées'));
  if (!data.outgoing.length) nodes.push(el('div', 'list-note small', 'Aucune demande en attente de réponse.'));
  data.outgoing.forEach(r => {
    const box = el('div', 'request');
    const head = btn('request-head', '', () => openProfile(r.profile.pid));
    const av = el('span', 'avatar sm');
    paintAvatar(av, r.profile);
    const text = el('div', 'contact-main');
    text.append(el('span', 'contact-name', r.profile.display_name), el('span', 'contact-sub', 'En attente de réponse'));
    head.append(av, text, btn('link small', 'Annuler', async e => {
      e.stopPropagation();
      try { await api('/api/requests/' + r.id, { method: 'DELETE' }); loadList(); } catch (err) { toast(err.message, true); }
    }));
    box.appendChild(head);
    nodes.push(box);
  });
  $('contacts').replaceChildren.apply($('contacts'), nodes);
}

/* ---------- Fiche profil d'un membre ---------- */
async function openProfile(pid) {
  const body = $('profile-body');
  $('profile-title').textContent = 'Profil';
  body.replaceChildren(el('p', 'muted', 'Chargement…'));
  if (!$('profile-dialog').open) $('profile-dialog').showModal();
  let p;
  try { p = await api(sp('/profiles/' + pid)); }
  catch (err) { body.replaceChildren(el('p', 'error', err.message)); return; }
  $('profile-title').textContent = space === 'business' && p.company ? p.company : p.display_name;
  const head = el('div', 'profile-card');
  const av = el('span', 'avatar xl');
  paintAvatar(av, p);
  av.onclick = () => {
    const img = av.querySelector('img');
    if (img) { $('photo-full').src = img.src; $('photo-dialog').showModal(); }
  };
  head.appendChild(av);
  if (space === 'business') {
    head.append(el('b', '', p.company || p.display_name), el('span', 'muted', [p.sector, p.city].filter(Boolean).join(' · ')), el('span', 'muted', 'Contact : ' + p.display_name));
  } else if (space === 'amour') {
    head.append(el('b', '', p.display_name), el('span', 'muted', [p.age ? p.age + ' ans' : null, p.sex === 'femme' ? 'Femme' : 'Homme', p.city].filter(Boolean).join(' · ')),
      el('span', 'muted', 'Recherche : ' + (p.seeking === 'les2' ? 'un homme ou une femme' : p.seeking === 'femme' ? 'une femme' : 'un homme')));
  } else {
    head.append(el('b', '', p.display_name), el('span', 'muted', p.city || ''));
  }
  const details = el('div', 'profile-details');
  if (p.activities) details.append(el('h3', '', 'Activités'), el('p', 'pre', p.activities));
  if (p.bio) details.append(el('h3', '', space === 'business' ? 'Présentation' : 'Biographie'), el('p', 'pre', p.bio));
  if (p.website) {
    const a = el('a', 'link', p.website);
    a.href = p.website;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    details.append(el('h3', '', 'Site internet'), a);
  }
  const actions = el('div', 'profile-actions');
  const rel = p.relation;
  const openChat = () => {
    $('profile-dialog').close();
    if (section !== 'chats') setSection('chats');
    openConv({ type: 'user', id: p.pid, pid: p.pid, display_name: p.display_name, avatar_v: p.avatar_v, subtitle: p.company || '' });
  };
  if (rel.status === 'self') {
    actions.appendChild(btn('primary', 'Modifier mon profil', () => { $('profile-dialog').close(); openSettings(); }));
  } else if (rel.status === 'blocked') {
    actions.appendChild(btn('primary', 'Débloquer', async () => { await setBlocked(p.pid, false); openProfile(p.pid); }));
  } else if (rel.can_message) {
    actions.appendChild(btn('primary', 'Écrire un message', openChat));
  } else if (rel.status === 'none') {
    const intro = el('textarea', 'field');
    intro.rows = 2;
    intro.maxLength = 300;
    intro.placeholder = 'Un petit mot pour vous présenter (facultatif)';
    actions.append(intro, btn('primary', 'Envoyer une demande', async e => {
      e.target.disabled = true;
      try {
        const r = await api(sp('/requests'), { json: { to_pid: p.pid, message: intro.value.trim() || null } });
        toast(r.status === 'connected' ? 'Vous êtes maintenant en contact !' : 'Demande envoyée. Vous pourrez discuter dès qu\'elle sera acceptée.');
        renderedSignature = '';
        loadList();
        openProfile(p.pid);
      } catch (err) { toast(err.message, true); e.target.disabled = false; }
    }));
  } else if (rel.status === 'pending_out') {
    const sent = btn('primary', 'Demande envoyée');
    sent.disabled = true;
    actions.append(sent, btn('link', 'Annuler la demande', async () => {
      try { await api('/api/requests/' + rel.request_id, { method: 'DELETE' }); openProfile(p.pid); loadList(); } catch (err) { toast(err.message, true); }
    }));
  } else if (rel.status === 'pending_in' || rel.status === 'declined_in') {
    actions.append(el('p', 'muted', 'Cette personne souhaite être en contact avec vous.'),
      btn('primary', 'Accepter la demande', async () => {
        try { await api('/api/requests/' + rel.request_id + '/accept', { method: 'POST' }); refreshUnread(); openChat(); } catch (err) { toast(err.message, true); }
      }));
    if (rel.status === 'pending_in') actions.appendChild(btn('link', 'Refuser', async () => {
      try { await api('/api/requests/' + rel.request_id + '/decline', { method: 'POST' }); $('profile-dialog').close(); refreshUnread(); loadList(); } catch (err) { toast(err.message, true); }
    }));
  } else {
    actions.appendChild(el('p', 'muted', 'Vous ne pouvez pas écrire à ce membre pour le moment.'));
  }
  const safety = el('div', 'profile-safety');
  if (rel.status !== 'self') {
    if (rel.status !== 'blocked') {
      const b = btn('link danger', 'Bloquer', async () => {
        if (!window.confirm('Bloquer ' + p.display_name + ' ? Cette personne ne pourra plus vous écrire, dans aucune rubrique.')) return;
        try { await setBlocked(p.pid, true); toast('Profil bloqué.'); openProfile(p.pid); } catch (err) { toast(err.message, true); }
      });
      b.prepend(icon('i-block'));
      safety.appendChild(b);
    }
    const r = btn('link danger', 'Signaler', () => openReport(p.pid, p.display_name));
    r.prepend(icon('i-flag'));
    safety.appendChild(r);
  }
  body.replaceChildren(head, details, actions, safety);
}

/* ---------- Blocage et signalement ---------- */
async function setBlocked(pid, block) {
  await api(sp('/blocks/' + pid), { method: block ? 'POST' : 'DELETE' });
  if (selected && selected.type === 'user' && selected.id === pid) {
    selected.blocked = block;
    refreshHeader();
  }
  renderedSignature = '';
  loadList();
}
$('blocked-unblock').onclick = async () => {
  try { await setBlocked(selected.id, false); toast('Contact débloqué.'); }
  catch (err) { toast(err.message, true); }
};
let reportTarget = null;
function openReport(pid, name, postId) {
  reportTarget = { pid: pid, post_id: postId || null };
  $('report-who').textContent = postId ? 'Publication de ' + name : 'Profil : ' + name;
  const select = $('report-reason');
  const reasons = cfg.report_reasons || {};
  select.replaceChildren.apply(select, [el('option', '', 'Choisissez un motif')].concat(Object.keys(reasons).map(k => { const o = el('option', '', reasons[k]); o.value = k; return o; })));
  select.firstChild.value = '';
  $('report-details').value = '';
  $('report-error').textContent = '';
  $('report-dialog').showModal();
}
$('report-form').onsubmit = async e => {
  e.preventDefault();
  if (!$('report-reason').value) { $('report-error').textContent = 'Choisissez un motif.'; return; }
  $('report-submit').disabled = true;
  try {
    const r = await api(sp('/reports'), { json: { pid: reportTarget.pid, reason: $('report-reason').value, details: $('report-details').value.trim() || null, post_id: reportTarget.post_id } });
    $('report-dialog').close();
    toast(r.message);
  } catch (err) { $('report-error').textContent = err.message; }
  finally { $('report-submit').disabled = false; }
};

/* ---------- Publications (Business) ---------- */
let feedOldest = 0, feedLoading = false, postImage = null;
function openFeed() {
  stopRecording(true);
  selected = null;
  showPane('feed');
  $('app').classList.add('chat-open');
  loadFeed(true);
}
$('feed-back').onclick = () => { $('app').classList.remove('chat-open'); showPane('placeholder'); };
function postNode(post) {
  const box = el('article', 'post');
  const head = el('div', 'post-head');
  const av = el('span', 'avatar sm');
  if (post.author) {
    paintAvatar(av, post.author);
    const who = btn('post-author', '', () => openProfile(post.author.pid));
    who.append(av, el('div', 'contact-main'));
    const parts = (post.author.subtitle || '').split(' · ');
    who.lastChild.append(el('b', '', parts[0] || post.author.display_name), el('span', 'muted', [parts[1], longFmt.format(new Date(post.created_at))].filter(Boolean).join(' · ')));
    head.appendChild(who);
  }
  box.appendChild(head);
  box.appendChild(el('p', 'post-body', post.body));
  if (post.image_url) {
    const img = el('img', 'post-img');
    img.alt = 'Image de la publication';
    api(post.image_url, { blob: true }).then(b => { img.src = URL.createObjectURL(b); }).catch(() => img.remove());
    img.onclick = () => { if (img.src) { $('photo-full').src = img.src; $('photo-dialog').showModal(); } };
    box.appendChild(img);
  }
  const actions = el('div', 'post-actions');
  if (post.author && !post.mine) actions.appendChild(btn('link', 'Contacter', () => openProfile(post.author.pid)));
  if (post.author && !post.mine) actions.appendChild(btn('link muted-link', 'Signaler', () => openReport(post.author.pid, post.author.display_name, post.id)));
  if (post.can_delete) actions.appendChild(btn('link danger', 'Supprimer', async () => {
    if (!window.confirm('Supprimer cette publication ?')) return;
    try { await api('/api/posts/' + post.id, { method: 'DELETE' }); box.remove(); toast('Publication supprimée.'); } catch (err) { toast(err.message, true); }
  }));
  box.appendChild(actions);
  return box;
}
async function loadFeed(reset) {
  if (feedLoading) return;
  feedLoading = true;
  if (reset) { feedOldest = 0; $('feed-list').replaceChildren(el('p', 'list-note', 'Chargement…')); }
  try {
    const rows = await api('/api/s/business/posts' + (feedOldest ? '?before=' + feedOldest : ''));
    if (reset) $('feed-list').replaceChildren();
    rows.forEach(p => $('feed-list').appendChild(postNode(p)));
    if (rows.length) feedOldest = rows[rows.length - 1].id;
    $('feed-more').hidden = rows.length < 20;
    if (reset && !rows.length) $('feed-list').appendChild(el('p', 'list-note', 'Aucune publication pour l\'instant. Soyez le premier à présenter votre activité !'));
  } catch (err) {
    if (reset) $('feed-list').replaceChildren(el('p', 'list-note', err.message));
  } finally { feedLoading = false; }
}
$('feed-more').onclick = () => loadFeed(false);
$('post-image-pick').onclick = () => $('post-image').click();
$('post-image').onchange = () => {
  postImage = ($('post-image').files && $('post-image').files[0]) || null;
  $('post-image').value = '';
  $('post-image-name').textContent = postImage ? postImage.name + ' (retirer)' : 'Ajouter une image';
  if (postImage) $('post-image-pick').onclick = () => { postImage = null; $('post-image-name').textContent = 'Ajouter une image'; $('post-image-pick').onclick = () => $('post-image').click(); };
};
$('post-form').onsubmit = async e => {
  e.preventDefault();
  const body = $('post-body').value.trim();
  if (!body) return toast('Écrivez le texte de votre publication.', true);
  $('post-submit').disabled = true;
  try {
    const form = new FormData();
    form.append('body', body);
    if (postImage) {
      const img = await shrinkImage(postImage, 1600, 0.85);
      if (img.size > 6 * 1024 * 1024) throw new Error('L\'image dépasse 6 Mo.');
      form.append('image', img, postImage.name || 'image.jpg');
    }
    const post = await api('/api/s/business/posts', { method: 'POST', body: form });
    $('post-body').value = '';
    postImage = null;
    $('post-image-name').textContent = 'Ajouter une image';
    $('post-image-pick').onclick = () => $('post-image').click();
    const empty = $('feed-list').querySelector('.list-note');
    if (empty) empty.remove();
    $('feed-list').prepend(postNode(post));
    toast('Publication en ligne.');
  } catch (err) { toast(err.message, true); }
  finally { $('post-submit').disabled = false; }
};

/* ---------- Conversation ouverte ---------- */
function refreshHeader() {
  if (!selected) return;
  $('chat-name').textContent = selected.display_name;
  $('chat-user').textContent = selected.type === 'group'
    ? (selected.members ? selected.members + ' membres · toucher pour les infos' : 'Groupe')
    : selected.unavailable ? 'Compte indisponible'
    : selected.blocked ? 'Contact bloqué' : (selected.subtitle || 'Voir le profil');
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
  showPane('chat');
  refreshHeader();
  $('messages').replaceChildren(el('div', 'list-note', 'Chargement…'));
  if (section === 'chats') renderChats();
  const opened = selected;
  try {
    const rows = await api(historyUrl(c, 0));
    if (selected !== opened) return;
    $('messages').replaceChildren();
    if (!rows.length) $('messages').appendChild(el('div', 'list-note', c.type === 'group' ? 'Aucun message. Lancez la discussion 👋' : 'Aucun message. Dites bonjour 👋'));
    appendMessages(rows, true, false);
    refreshUnread();
  } catch (err) {
    if (selected === opened) $('messages').replaceChildren(el('div', 'list-note', err.message));
  }
  if (matchMedia('(min-width: 761px)').matches && !$('composer').hidden) $('message').focus();
}
function closeConv() {
  stopRecording(true);
  selected = null;
  $('app').classList.remove('chat-open');
  showPane('placeholder');
  renderedSignature = '';
  loadList();
}
$('back').onclick = closeConv;
$('chat-more').onclick = openConvInfo;
$('chat-title').onclick = openConvInfo;
$('chat-title').onkeydown = e => { if (e.key === 'Enter') openConvInfo(); };

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
  const b = btn('voice', '');
  const play = el('span', 'play');
  play.appendChild(icon(iconName));
  const text = el('span', 'voice-label', label);
  b.append(play, text);
  b.onclick = async () => {
    b.disabled = true;
    text.textContent = 'Chargement…';
    try {
      const player = makePlayer(await loadMedia(m));
      b.replaceWith(player);
      const p = player.play && player.play();
      if (p && p.catch) p.catch(() => {});
    } catch (err) {
      b.disabled = false;
      text.textContent = label;
      toast(err.message, true);
    }
  };
  return b;
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
  const box = btn('photo', '');
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
  if (kind === 'video' && m.media_url) return playableNode(m, 'Vidéo' + (m.media_size ? ' · ' + formatSize(m.media_size) : ''), 'i-video', videoPlayer);
  if (kind === 'audio' && m.media_url) return playableNode(m, m.media_name || 'Fichier audio', 'i-music', audioPlayer);
  if (m.media_url) return playableNode(m, 'Message vocal', 'i-play', audioPlayer);
  return el('div', 'text', m.body || '');
}
function appendMessages(rows, forceScroll, live) {
  if (!rows.length) return;
  const box = $('messages');
  const stick = nearBottom(box);
  if (!lastId) { const note = box.querySelector('.list-note'); if (note) note.remove(); }
  const inGroup = selected && selected.type === 'group';
  const myPid = myProfile() ? myProfile().pid : null;
  let incoming = false;
  for (const m of rows) {
    if (m.id <= lastId) continue;
    const date = new Date(m.created_at), key = dayKey(date);
    if (key !== lastDay) { box.appendChild(el('div', 'day', dayLabel(date))); lastDay = key; lastSender = null; }
    const mine = m.sender_pid === myPid;
    if (!mine) incoming = true;
    const kind = m.kind || 'text';
    const bubble = el('div', 'bubble ' + (mine ? 'mine' : 'theirs') + ' k-' + kind + (lastSender !== null && lastSender !== m.sender_pid ? ' gap' : ''));
    if (inGroup && !mine && lastSender !== m.sender_pid) {
      const name = btn('sender', m.sender_name || 'Membre', () => { if (m.sender_pid) openProfile(m.sender_pid); });
      name.style.setProperty('--h', hueOf('s' + m.sender_pid));
      bubble.appendChild(name);
    }
    bubble.appendChild(messageContent(m));
    bubble.appendChild(el('div', 'time', timeFmt.format(date)));
    box.appendChild(bubble);
    lastId = m.id; lastSender = m.sender_pid;
  }
  if (forceScroll || stick) box.scrollTop = box.scrollHeight;
  if (live && incoming) { playSound(); blinkTitle('💬 Nouveau message'); }
}
async function fetchNew(forceScroll, live) {
  const c = selected;
  if (!c) return;
  const rows = await api(historyUrl(c, lastId));
  if (selected === c) appendMessages(rows, forceScroll, live);
}

/* ---------- Envoi de texte ---------- */
const input = $('message');
function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight + 2, 140) + 'px';
  $('send').disabled = !input.value.trim();
}
input.oninput = resizeInput;
input.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(min-width: 761px)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
};
$('composer').onsubmit = async e => {
  e.preventDefault();
  const body = input.value.trim();
  if (!body || !selected || $('send').dataset.busy) return;
  $('send').dataset.busy = '1';
  try {
    await api(sp('/messages'), { json: Object.assign({ body: body }, targetFields()) });
    input.value = '';
    resizeInput();
    await fetchNew(true, false);
    renderedSignature = '';
    if (section === 'chats') loadList();
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
function sendWithProgress(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentUpload = xhr;
    xhr.open('POST', url);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      currentUpload = null;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401 && me) signOut('Votre session a expiré. Reconnectez-vous.');
      reject(new Error(errorText(data, xhr.status === 413 ? 'Fichier trop volumineux.' : 'Envoi impossible.')));
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
      else form.append('to_pid', item.target.to_pid);
      if (item.name) form.append('name', item.name);
      form.append('file', blob, item.name || 'fichier');
      $('upload-name').textContent = 'Envoi de ' + (item.name || 'votre fichier');
      await sendWithProgress('/api/s/' + item.space + '/media', form, ratio => { $('upload-fill').style.width = Math.round(ratio * 100) + '%'; });
      if (selected && item.conv === (item.space + selected.type + selected.id) && space === item.space) await fetchNew(true, false);
    } catch (err) {
      if (err.message !== 'Envoi annulé.') toast(err.message, true);
    }
    uploadQueue.shift();
  }
  $('upload-bar').hidden = true;
  renderedSignature = '';
  if (section === 'chats') loadList();
}
$('attach').onclick = () => $('file-input').click();
$('file-input').onchange = () => {
  const files = Array.prototype.slice.call($('file-input').files || []);
  $('file-input').value = '';
  if (!selected) return;
  files.forEach(file => {
    const kind = kindOf(file);
    if (!kind) return toast('« ' + file.name + ' » n\'est ni une photo, ni une vidéo, ni un fichier audio.', true);
    queueUpload({ kind: kind, file: file, name: file.name, target: targetFields(), space: space, conv: space + selected.type + selected.id });
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
  const target = targetFields(), conv = space + selected.type + selected.id, recSpace = space;
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
    queueUpload({ kind: 'voice', file: blob, name: null, target: target, space: recSpace, conv: conv });
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

/* ---------- Infos de groupe ---------- */
function memberRow(u, extra) {
  const row = el('div', 'member');
  const av = el('span', 'avatar sm');
  paintAvatar(av, u);
  const text = el('div', 'member-text');
  text.appendChild(el('b', '', u.display_name + (u.is_me ? ' (vous)' : '')));
  if (u.subtitle) text.appendChild(el('span', 'muted', u.subtitle));
  row.append(av, text);
  if (extra) extra.forEach(node => row.appendChild(node));
  return row;
}
async function openConvInfo() {
  if (!selected) return;
  if (selected.type === 'user') return openProfile(selected.id);
  const body = $('conv-body');
  $('conv-title').textContent = selected.display_name;
  body.replaceChildren(el('p', 'muted', 'Chargement…'));
  $('conv-dialog').showModal();
  try { renderGroupInfo(body, await api('/api/groups/' + selected.id)); }
  catch (err) { body.replaceChildren(el('p', 'error', err.message)); }
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
        loadList();
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
    if (!u.is_me) extra.push(btn('link small', 'Profil', () => { $('conv-dialog').close(); openProfile(u.pid); }));
    if (g.is_admin && !u.is_me) {
      extra.push(btn('link danger small', 'Retirer', async () => {
        if (!window.confirm('Retirer ' + u.display_name + ' du groupe ?')) return;
        try { renderGroupInfo(body, await api('/api/groups/' + g.id + '/members/' + u.pid, { method: 'DELETE' })); }
        catch (err) { toast(err.message, true); }
      }));
    }
    list.appendChild(memberRow(u, extra));
  });
  nodes.push(list);
  const actions = el('div', 'dialog-actions');
  actions.appendChild(btn('link danger', 'Quitter le groupe', async () => {
    if (!window.confirm('Quitter le groupe « ' + g.name + ' » ?')) return;
    try {
      await api('/api/groups/' + g.id + '/members/' + myProfile().pid, { method: 'DELETE' });
      $('conv-dialog').close();
      toast('Vous avez quitté le groupe.');
      closeConv();
    } catch (err) { toast(err.message, true); }
  }));
  if (g.is_admin) actions.appendChild(btn('primary', 'Ajouter des membres', () => { $('conv-dialog').close(); openGroupPicker({ mode: 'add', group: g }); }));
  nodes.push(actions);
  body.replaceChildren.apply(body, nodes);
}

/* ---------- Création de groupe / ajout de membres ---------- */
let picker = null; // { mode: 'create' | 'add', group, picked: Map, pool: [] }
function updatePickCount() {
  const n = picker.picked.size;
  $('group-count').textContent = n ? n + ' membre' + (n > 1 ? 's' : '') + ' choisi' + (n > 1 ? 's' : '') : 'Aucun membre choisi';
}
// Membres possibles : en Business, toute la rubrique ; ailleurs, uniquement vos contacts acceptés.
async function loadPickPool() {
  if (space === 'business') return (await api(sp('/directory'))).map(p => ({ pid: p.pid, display_name: p.display_name, avatar_v: p.avatar_v, subtitle: p.subtitle }));
  return (await api(sp('/conversations'))).filter(c => c.type === 'user' && !c.blocked && !c.unavailable)
    .map(c => ({ pid: c.id, display_name: c.display_name, avatar_v: c.avatar_v, subtitle: c.subtitle }));
}
function renderPickList() {
  const box = $('group-pick');
  const q = $('group-search').value.trim().toLowerCase();
  const existing = picker.group ? picker.group.members.map(m => m.pid) : [];
  const rows = picker.pool.filter(u => existing.indexOf(u.pid) < 0 && (!q || u.display_name.toLowerCase().indexOf(q) >= 0 || (u.subtitle || '').toLowerCase().indexOf(q) >= 0));
  if (!rows.length) {
    box.replaceChildren(el('p', 'muted', q ? 'Aucun contact trouvé.' : space === 'business' ? 'Aucun membre à ajouter.' : 'Aucun contact à ajouter. Dans cette rubrique, on ne peut ajouter que des contacts qui ont accepté votre demande.'));
    return;
  }
  box.replaceChildren.apply(box, rows.map(u => {
    const label = el('label', 'pick');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = picker.picked.has(u.pid);
    check.onchange = () => {
      if (check.checked) picker.picked.set(u.pid, u); else picker.picked.delete(u.pid);
      updatePickCount();
    };
    label.append(check, memberRow(u));
    return label;
  }));
}
async function openGroupPicker(options) {
  picker = { mode: options.mode, group: options.group || null, picked: new Map(), pool: [] };
  const creating = picker.mode === 'create';
  $('group-title').textContent = creating ? 'Nouveau groupe ' + SPACE_META[space].label : 'Ajouter des membres';
  $('group-name-wrap').hidden = !creating;
  $('group-name').value = '';
  $('group-search').value = '';
  $('group-error').textContent = '';
  $('group-submit').textContent = creating ? 'Créer le groupe' : 'Ajouter';
  $('group-pick').replaceChildren(el('p', 'muted', 'Chargement…'));
  updatePickCount();
  $('group-dialog').showModal();
  try { picker.pool = await loadPickPool(); renderPickList(); }
  catch (err) { $('group-pick').replaceChildren(el('p', 'error', err.message)); }
  if (creating) $('group-name').focus();
}
$('group-new').onclick = () => openGroupPicker({ mode: 'create' });
$('group-search').oninput = () => { if (picker) renderPickList(); };
$('group-form').onsubmit = async e => {
  e.preventDefault();
  const ids = Array.from(picker.picked.keys());
  const fail = msg => { $('group-error').textContent = msg; };
  if (picker.mode === 'create' && !$('group-name').value.trim()) return fail('Donnez un nom au groupe.');
  if (!ids.length) return fail('Choisissez au moins un membre.');
  $('group-submit').disabled = true;
  try {
    if (picker.mode === 'create') {
      const g = await api(sp('/groups'), { json: { name: $('group-name').value, member_pids: ids } });
      $('group-dialog').close();
      toast('Groupe « ' + g.name + ' » créé.');
      renderedSignature = '';
      loadList();
      openConv({ type: 'group', id: g.id, display_name: g.name, members: g.members.length });
    } else {
      const g = await api('/api/groups/' + picker.group.id + '/members', { json: { pids: ids } });
      $('group-dialog').close();
      toast(ids.length > 1 ? 'Membres ajoutés.' : 'Membre ajouté.');
      selected.members = g.members.length;
      refreshHeader();
      loadList();
    }
  } catch (err) { fail(err.message); }
  finally { $('group-submit').disabled = false; }
};

/* ---------- Paramètres ---------- */
let spaceForm = null;
function openSettings() {
  const p = myProfile();
  const meta = SPACE_META[space];
  $('set-profile-title').textContent = 'Mon profil ' + meta.emoji + ' ' + meta.label;
  spaceForm = profileForm(space, p);
  $('space-profile-fields').replaceChildren(spaceForm.node);
  $('space-profile-error').textContent = '';
  paintAvatar($('set-avatar'), p);
  $('avatar-remove').hidden = !p.avatar_v;
  $('set-username').value = me.username;
  $('set-phone').value = me.phone || '';
  $('pw-username').value = me.username;
  ['pw-current', 'pw-new', 'pw-confirm'].forEach(id => { $(id).value = ''; });
  $('profile-error').textContent = '';
  $('password-error').textContent = '';
  renderMySpaces();
  renderSoundSettings();
  renderPushStatus();
  $('settings-dialog').showModal();
  loadBlockedList();
}
$('settings-open').onclick = openSettings;
function renderMySpaces() {
  const box = $('my-spaces');
  box.replaceChildren.apply(box, SPACE_ORDER.map(s => {
    const meta = SPACE_META[s];
    const row = el('div', 'my-space');
    row.append(el('span', 'space-emoji', meta.emoji), el('b', '', meta.label));
    if (me.profiles[s]) {
      row.appendChild(el('span', 'muted', me.profiles[s].display_name));
      if (s !== space) row.appendChild(btn('link small', 'Ouvrir', () => { $('settings-dialog').close(); setSpace(s); }));
      else row.appendChild(el('span', 'tag', 'Ouverte'));
    } else {
      row.appendChild(el('span', 'muted', 'Pas encore membre'));
      row.appendChild(btn('primary small-btn', 'Rejoindre', () => { $('settings-dialog').close(); openJoin(s); }));
    }
    return row;
  }));
}
function afterMeChange(data) {
  me = data;
  renderMe();
  renderSpaceTabs();
  const p = myProfile();
  paintAvatar($('set-avatar'), p);
  $('avatar-remove').hidden = !p.avatar_v;
}
$('space-profile-form').onsubmit = async e => {
  e.preventDefault();
  const problem = spaceForm.validate();
  if (problem) { $('space-profile-error').textContent = problem; return; }
  $('space-profile-error').textContent = '';
  $('space-profile-save').disabled = true;
  try {
    afterMeChange(await api('/api/me/profiles/' + space, { method: 'PATCH', json: spaceForm.read() }));
    toast('Profil ' + SPACE_META[space].label + ' enregistré.');
  } catch (err) { $('space-profile-error').textContent = err.message; }
  finally { $('space-profile-save').disabled = false; }
};
async function uploadAvatar(blob) {
  const form = new FormData();
  form.append('photo', blob, 'photo.jpg');
  try {
    afterMeChange(await api('/api/me/profiles/' + space + '/avatar', { method: 'PUT', body: form }));
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
  ctx.fillText(initial(myProfile().display_name), size / 2, size / 2 + 8);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}
$('avatar-random').onclick = async () => { const blob = await randomAvatar(); if (blob) uploadAvatar(blob); };
$('avatar-remove').onclick = async () => {
  try { afterMeChange(await api('/api/me/profiles/' + space + '/avatar', { method: 'DELETE' })); toast('Photo retirée.'); }
  catch (err) { toast(err.message, true); }
};
$('profile-form').onsubmit = async e => {
  e.preventDefault();
  const fail = msg => { $('profile-error').textContent = msg; };
  const username = $('set-username').value.trim();
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return fail('Nom d\'utilisateur : 3 à 40 caractères (lettres, chiffres, point, tiret, souligné).');
  fail('');
  $('profile-save').disabled = true;
  try {
    me = await api('/api/me', { method: 'PATCH', json: { username: username, phone: $('set-phone').value.trim() } });
    $('set-username').value = me.username;
    $('set-phone').value = me.phone || '';
    toast('Compte enregistré.');
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
    if (pushSupported() && Notification.permission === 'granted') ensurePush();
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
      const unblock = btn('link small', 'Débloquer', async () => {
        try {
          await api('/api/s/' + u.space + '/blocks/' + u.pid, { method: 'DELETE' });
          toast(u.display_name + ' est débloqué.');
          loadBlockedList();
          renderedSignature = '';
          loadList();
        } catch (err) { toast(err.message, true); }
      });
      return memberRow(Object.assign({}, u, { subtitle: SPACE_META[u.space].emoji + ' ' + SPACE_META[u.space].label }), [unblock]);
    }));
  } catch (err) { box.replaceChildren(el('p', 'error', err.message)); }
}
function renderSoundSettings() {
  const select = $('sound-choice');
  const current = pref('cm_sound', 'carillon');
  select.replaceChildren.apply(select, Object.keys(SOUNDS).map(k => { const o = el('option', '', SOUNDS[k].label); o.value = k; o.selected = k === current; return o; }));
  $('vibrate-choice').checked = pref('cm_vibrate', '1') === '1';
}
$('sound-choice').onchange = () => { setPref('cm_sound', $('sound-choice').value); unlockAudio(); playSound($('sound-choice').value, true); };
$('sound-test').onclick = () => { unlockAudio(); playSound($('sound-choice').value, true); };
$('vibrate-choice').onchange = () => setPref('cm_vibrate', $('vibrate-choice').checked ? '1' : '0');

/* ---------- Rejoindre une autre rubrique ---------- */
let joinState = null;
function openJoin(target) {
  const missing = SPACE_ORDER.filter(s => !me.profiles[s]);
  if (!missing.length) return;
  joinState = { space: target && missing.indexOf(target) >= 0 ? target : (missing.length === 1 ? missing[0] : null), form: null };
  renderJoin();
  $('join-error').textContent = '';
  $('join-dialog').showModal();
}
function renderJoin() {
  const body = $('join-body');
  if (!joinState.space) {
    $('join-title').textContent = 'Rejoindre une rubrique';
    $('join-submit').hidden = true;
    body.replaceChildren.apply(body, SPACE_ORDER.filter(s => !me.profiles[s]).map(s => {
      const meta = SPACE_META[s];
      const cardNode = btn('space-card pick-space', '', () => { joinState.space = s; renderJoin(); });
      cardNode.dataset.space = s;
      const head = el('div', 'space-card-head');
      head.append(el('span', 'space-emoji', meta.emoji), el('b', '', meta.label));
      cardNode.append(head, el('p', '', meta.pitch));
      return cardNode;
    }));
    return;
  }
  const meta = SPACE_META[joinState.space];
  $('join-title').textContent = meta.emoji + ' Rejoindre ' + meta.label;
  $('join-submit').hidden = false;
  joinState.form = profileForm(joinState.space, {});
  body.replaceChildren(el('p', 'muted', meta.pitch), joinState.form.node);
}
$('join-form').onsubmit = async e => {
  e.preventDefault();
  const problem = joinState.form.validate();
  if (problem) { $('join-error').textContent = problem; return; }
  $('join-submit').disabled = true;
  try {
    me = await api('/api/me/profiles/' + joinState.space, { json: joinState.form.read() });
    $('join-dialog').close();
    toast('Bienvenue dans ' + SPACE_META[joinState.space].label + ' !');
    setSpace(joinState.space);
    setSection('discover');
  } catch (err) { $('join-error').textContent = err.message; }
  finally { $('join-submit').disabled = false; }
};

/* ---------- Notifications (application fermée) ---------- */
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!cfg.push_key; }
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function ensurePush() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.push_key) });
  await api('/api/push/subscribe', { json: JSON.parse(JSON.stringify(sub)) });
}
async function enablePush() {
  if (!pushSupported()) {
    toast(isIOS ? 'Sur iPhone : installez d\'abord l\'application sur l\'écran d\'accueil (iOS 16.4 ou plus récent).' : 'Ce navigateur ne permet pas les notifications.', true);
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications refusées. Vous pouvez les autoriser plus tard dans les réglages du téléphone.', true); refreshNotifCard(); renderPushStatus(); return; }
    await ensurePush();
    toast('Notifications activées sur cet appareil.');
  } catch (err) { toast('Impossible d\'activer les notifications : ' + err.message, true); }
  refreshNotifCard();
  renderPushStatus();
}
function refreshNotifCard() {
  let hidden = true;
  if (pushSupported()) {
    if (Notification.permission === 'granted') ensurePush().catch(() => {});
    hidden = Notification.permission !== 'default' || pref('cm_notif_hidden', '0') === '1';
  }
  $('notif-card').hidden = hidden;
}
$('notif-enable').onclick = enablePush;
$('notif-close').onclick = () => { setPref('cm_notif_hidden', '1'); refreshNotifCard(); };
function renderPushStatus() {
  const box = $('push-status');
  if (!pushSupported()) {
    box.replaceChildren(el('p', 'muted', isIOS
      ? 'Notifications application fermée : installez l\'application sur l\'écran d\'accueil (iPhone avec iOS 16.4 ou plus récent).'
      : 'Ce navigateur ne permet pas les notifications quand l\'application est fermée. Le son fonctionne quand elle est ouverte.'));
  } else if (Notification.permission === 'granted') {
    box.replaceChildren(el('p', 'ok-text', '✔ Notifications activées sur cet appareil.'));
  } else if (Notification.permission === 'denied') {
    box.replaceChildren(el('p', 'muted', 'Notifications bloquées : autorisez-les dans les réglages du navigateur ou du téléphone, pour ce site.'));
  } else {
    box.replaceChildren(btn('primary', 'Activer les notifications', enablePush));
  }
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'open' && d.target) handleOpen(d.target);
    if (d.type === 'push') poll();
  });
}
// Ouvre directement ce qu'une notification annonce : « rubrique:user:pid », « rubrique:group:id » ou « rubrique:requests ».
async function handleOpen(target) {
  if (!me) return;
  const parts = String(target).split(':');
  const s = parts[0], kind = parts[1], id = parseInt(parts[2], 10);
  if (me.spaces.indexOf(s) < 0) return;
  if (s !== space) setSpace(s);
  try {
    if (kind === 'requests') setSection('requests');
    else if (kind === 'user' && id) {
      if (section !== 'chats') setSection('chats');
      const p = await api(sp('/profiles/' + id));
      openConv({ type: 'user', id: p.pid, pid: p.pid, display_name: p.display_name, avatar_v: p.avatar_v, subtitle: p.company || '' });
    } else if (kind === 'group' && id) {
      if (section !== 'chats') setSection('chats');
      const g = await api('/api/groups/' + id);
      openConv({ type: 'group', id: g.id, display_name: g.name, members: g.members.length });
    }
  } catch (err) { toast(err.message, true); }
}

/* ---------- Compteurs, sons et actualisation ---------- */
async function refreshUnread(initial) {
  let data;
  try { data = await api('/api/unread'); } catch (e) { return; }
  if (!me) return;
  if (!initial && unreadState) {
    let ring = false, where = null, isRequest = false;
    Object.keys(data).forEach(s => {
      const before = unreadState[s] || { messages: 0, requests: 0 };
      if (data[s].messages > before.messages) { ring = true; where = where || s; }
      if (data[s].requests > before.requests) { ring = true; where = where || s; isRequest = true; }
    });
    if (ring) {
      playSound();
      const label = SPACE_META[where].emoji + ' ' + (isRequest ? 'Nouvelle demande de contact' : 'Nouveau message') + ' dans ' + SPACE_META[where].label;
      if (where !== space || document.hidden || section !== 'chats') toast(label);
      blinkTitle(label);
    }
  }
  unreadState = data;
  let total = 0;
  Object.keys(data).forEach(s => { total += data[s].messages + data[s].requests; });
  baseTitle = (total ? '(' + total + ') ' : '') + 'COOL MESSENGER';
  if (!titleBlink || !document.hidden) document.title = baseTitle;
  try { if (navigator.setAppBadge) { if (total) navigator.setAppBadge(total); else navigator.clearAppBadge(); } } catch (e) {}
  renderSpaceTabs();
  renderSectionTabs();
}
async function poll() {
  if (!me || pollBusy) return;
  pollBusy = true;
  try {
    tick++;
    if (selected && !document.hidden) await fetchNew(false, true);
    if (tick % 2 === 0 || document.hidden) await refreshUnread(false);
    if (!document.hidden && tick % 2 === 0 && (section === 'chats' || section === 'requests')) await loadList();
    if (me.is_admin && tick % 20 === 0) refreshAdminBadge();
  } catch (e) {} finally { pollBusy = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ---------- Administration ---------- */
let adminTab = 'open';
async function refreshAdminBadge() {
  try { const o = await api('/api/admin/overview'); $('admin-badge').hidden = !o.open_reports; } catch (e) {}
}
$('admin-open').onclick = () => { $('admin-dialog').showModal(); loadAdmin(); };
document.querySelectorAll('[data-admin]').forEach(tab => {
  tab.onclick = () => {
    adminTab = tab.dataset.admin;
    document.querySelectorAll('[data-admin]').forEach(t => t.classList.toggle('active', t === tab));
    $('admin-search').hidden = adminTab !== 'users';
    loadAdmin();
  };
});
let adminSearchTimer = null;
$('admin-search').oninput = () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(loadAdmin, 300); };
async function suspendAccount(u) {
  const reason = window.prompt('Motif de la suspension de « ' + u.username + ' » (il sera affiché à la personne) :', 'Non-respect des règles de la communauté');
  if (!reason) return;
  try { await api('/api/admin/users/' + u.id + '/suspend', { json: { reason: reason } }); toast('Compte suspendu.'); loadAdmin(); }
  catch (err) { toast(err.message, true); }
}
function adminAccountLine(u) {
  const line = el('div', 'admin-account');
  line.appendChild(el('b', '', '@' + u.username + (u.suspended ? ' · suspendu' : '')));
  line.appendChild(el('span', 'muted', u.profiles.map(p => SPACE_META[p.space].emoji + ' ' + p.display_name).join('  ·  ') || 'Aucun profil'));
  if (u.suspended && u.suspended_reason) line.appendChild(el('span', 'muted', 'Motif : ' + u.suspended_reason));
  return line;
}
async function loadAdmin() {
  const body = $('admin-body');
  body.replaceChildren(el('p', 'muted', 'Chargement…'));
  try {
    const o = await api('/api/admin/overview');
    const stats = [['Comptes', o.users], ['💼 Business', o.per_space.business || 0], ['❤️ Amour', o.per_space.amour || 0], ['💬 Gbairai', o.per_space.gbairai || 0],
                   ['Messages', o.messages], ['Publications', o.posts], ['Signalements', o.open_reports], ['Base', o.db_size_mb + ' Mo / 1 Go']];
    $('admin-stats').replaceChildren.apply($('admin-stats'), stats.map(s => { const b = el('div', 'stat'); b.append(el('b', '', String(s[1])), el('span', 'muted', s[0])); return b; }));
    $('admin-badge').hidden = !o.open_reports;
    if (adminTab === 'users') {
      const users = await api('/api/admin/users?q=' + encodeURIComponent($('admin-search').value.trim()));
      body.replaceChildren.apply(body, users.length ? users.map(u => {
        const card = el('div', 'admin-card');
        card.appendChild(adminAccountLine(u));
        const actions = el('div', 'request-actions');
        if (u.suspended) actions.appendChild(btn('primary', 'Réactiver', async () => { try { await api('/api/admin/users/' + u.id + '/unsuspend', { method: 'POST' }); toast('Compte réactivé.'); loadAdmin(); } catch (err) { toast(err.message, true); } }));
        else if (u.username !== me.username) actions.appendChild(btn('link danger', 'Suspendre', () => suspendAccount(u)));
        card.appendChild(actions);
        return card;
      }) : [el('p', 'muted', 'Aucun compte trouvé.')]);
      return;
    }
    const reports = await api('/api/admin/reports?status=' + adminTab);
    if (!reports.length) { body.replaceChildren(el('p', 'muted', adminTab === 'open' ? 'Aucun signalement en attente. 👍' : 'Aucun signalement traité.')); return; }
    body.replaceChildren.apply(body, reports.map(r => {
      const card = el('div', 'admin-card');
      const meta = SPACE_META[r.space] || { emoji: '', label: '' };
      card.appendChild(el('div', 'admin-reason', meta.emoji + ' ' + r.reason));
      card.appendChild(el('span', 'muted', 'Le ' + longFmt.format(new Date(r.created_at)) + ' par @' + r.reporter + ' · ' + r.reports_against_target + ' signalement(s) contre ce compte'));
      if (r.target_profile) card.appendChild(el('p', '', 'Profil signalé : ' + r.target_profile.display_name + (r.target_profile.company ? ' (' + r.target_profile.company + ')' : '')));
      if (r.details) card.appendChild(el('p', 'request-msg', '« ' + r.details + ' »'));
      if (r.post) card.appendChild(el('p', 'request-msg', 'Publication : « ' + r.post.body + ' »'));
      if (r.target) card.appendChild(adminAccountLine(r.target));
      const actions = el('div', 'request-actions');
      if (r.post) actions.appendChild(btn('link danger', 'Supprimer la publication', async () => {
        try { await api('/api/posts/' + r.post.id, { method: 'DELETE' }); toast('Publication supprimée.'); loadAdmin(); } catch (err) { toast(err.message, true); }
      }));
      if (r.target && !r.target.suspended) actions.appendChild(btn('link danger', 'Suspendre le compte', () => suspendAccount(r.target)));
      if (r.status === 'open') actions.appendChild(btn('primary', 'Marquer comme traité', async () => {
        try { await api('/api/admin/reports/' + r.id + '/close', { method: 'POST' }); loadAdmin(); } catch (err) { toast(err.message, true); }
      }));
      card.appendChild(actions);
      return card;
    }));
  } catch (err) { body.replaceChildren(el('p', 'error', err.message)); }
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
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
api('/api/config').then(c => { cfg = c; }).catch(() => {}).then(() => {
  if (token) start();
  else showLogin();
});
