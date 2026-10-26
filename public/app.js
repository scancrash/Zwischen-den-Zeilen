// Buchclub – Frontend ohne Build-Schritt. Alle Inhalte werden per DOM-API eingesetzt (kein innerHTML → kein XSS).

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const dlg = $('#dialog');

let S = null; // Server-State
let tab = (() => { try { return localStorage.getItem('tab') || 'home'; } catch { return 'home'; } })();
const openComments = new Map(); // bookId -> Kommentarliste | null (lädt)

// ---------- Helfer ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && S?.me) { S = null; render(); }
    throw new Error(data.error || 'Etwas ist schiefgelaufen.');
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Führt eine Aktion aus, lädt danach den State neu und zeigt Fehler als Toast.
async function act(fn, okMsg) {
  try {
    await fn();
    await load();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message);
  }
}

const dateFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) => dateFmt.format(new Date(iso)) + ' Uhr';
const ago = (sqlDate) => shortFmt.format(new Date(sqlDate.replace(' ', 'T') + 'Z'));

function toLocalInput(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const gcalDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function googleLink(m) {
  const start = new Date(m.starts_at);
  const end = new Date(start.getTime() + m.duration_min * 60000);
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: m.book_title ? `${S.club_name}: ${m.book_title}` : S.club_name,
    dates: `${gcalDate(start)}/${gcalDate(end)}`,
    location: m.location || '',
    details: m.notes || '',
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

const bookCover = (b, big) =>
  b.cover_url || b.book_cover
    ? h('img', { class: 'cover' + (big ? ' big' : ''), src: b.cover_url || b.book_cover, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
    : h('div', { class: 'cover empty' + (big ? ' big' : ''), 'aria-hidden': 'true' }, '📖');

const nextMeeting = () => S.meetings.find((m) => new Date(m.starts_at).getTime() + m.duration_min * 60000 > Date.now());

// Icons: feste, eigene SVG-Pfade (kein Nutzerinhalt)
const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 1 2-2h13v3H6a2 2 0 0 1-2-1z"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .7 3.5 2.7 3.5 5.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
function icon(name) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.setAttribute('aria-hidden', 'true');
  span.insertAdjacentHTML('beforeend', `<svg class="icon" viewBox="0 0 24 24">${ICONS[name]}</svg>`);
  return span;
}

function go(id) {
  tab = id;
  try { localStorage.setItem('tab', id); } catch {}
  render();
  window.scrollTo(0, 0);
}

// ---------- Laden / Rendern ----------
async function load() {
  S = await api('GET', '/api/state');
  render();
}

function render() {
  const scroll = window.scrollY;
  app.replaceChildren();
  if (!S || !S.me) {
    app.append(authView());
    return;
  }
  const views = { home: homeView, ideas: ideasView, list: listView, dates: datesView, club: clubView };
  app.append(
    h('main', {}, views[tab]()),
    h('nav', { class: 'tabs', 'aria-label': 'Hauptnavigation' },
      [['home', 'home', 'Start'], ['ideas', 'bulb', 'Ideen'], ['list', 'book', 'Liste'], ['dates', 'cal', 'Termine'], ['club', 'users', 'Club']].map(([id, ic, label]) =>
        h('button', { class: tab === id ? 'active' : '', 'aria-current': tab === id ? 'page' : null, 'aria-label': label, onclick: () => go(id) },
          icon(ic), h('span', { class: 'lbl' }, label)))),
  );
  window.scrollTo(0, scroll);
}

// ---------- Login ----------
const LOGO = `<svg class="logo" viewBox="0 0 200 170" aria-hidden="true">
  <ellipse cx="100" cy="110" rx="92" ry="40" fill="none" stroke="#c9a98a" stroke-width="3" transform="rotate(-8 100 110)"/>
  <path d="M30 20h74a16 16 0 0 1 16 16v54a16 16 0 0 1-16 16H70l-26 20v-20H30a16 16 0 0 1-16-16V36a16 16 0 0 1 16-16z" fill="#8b4a32"/>
  <path d="M36 50c10-4 20-3 28 3v34c-8-6-18-7-28-3zM92 50c-10-4-20-3-28 3v34c8-6 18-7 28-3z" fill="#fbf8f2"/>
  <path d="M110 70h60a16 16 0 0 1 16 16v44a16 16 0 0 1-16 16h-8v18l-22-18h-30a16 16 0 0 1-16-16V86a16 16 0 0 1 16-16z" fill="#66714a"/>
  <path d="M118 96h44M118 110h32M118 124h38" stroke="#fbf8f2" stroke-width="5" stroke-linecap="round"/>
  <path d="M170 18l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="#d9b98f"/></svg>`;
const WAVE = `<svg class="wave" viewBox="0 0 400 260" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 90c70 40 120-40 200-10s140 40 200-10v190H0z" fill="#d9b98f" opacity=".45"/>
  <path d="M0 150c80-40 130 20 210 0s130-30 190 0v110H0z" fill="#8b4a32" opacity=".22"/></svg>`;

function authView() {
  const first = S && !S.has_users;
  let seen = false;
  try { seen = localStorage.getItem('seenWelcome') === '1'; } catch {}
  let mode = first ? 'register' : 'login';
  const box = h('div', { class: 'welcome' });
  const title = S?.club_name || 'Buchclub';

  const drawWelcome = () => {
    const logo = h('div'); logo.insertAdjacentHTML('beforeend', LOGO);
    const wave = h('div'); wave.insertAdjacentHTML('beforeend', WAVE);
    box.replaceChildren(wave.firstChild, logo.firstChild, h('h1', {}, title),
      h('p', { class: 'tag' }, h('span', { class: 'a' }, 'Gemeinsam lesen.'), h('br'), h('span', { class: 'b' }, 'Gemeinsam darüber reden.')),
      h('div', { class: 'spacer' }),
      h('button', { class: 'start', onclick: () => { try { localStorage.setItem('seenWelcome', '1'); } catch {} drawForm(); } },
        first ? 'Club gründen' : 'Loslegen', h('span', { class: 'go' }, icon('arrow'))));
  };

  const drawForm = () => {
    const err = h('p', { class: 'err', role: 'alert' });
    const name = h('input', { autocomplete: 'username', required: true, maxLength: 40 });
    const pw = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });
    const invite = h('input', { autocapitalize: 'characters', autocomplete: 'off' });
    box.replaceChildren(
      h('div', { class: 'spacer', style: 'flex:0;min-height:6vh' }),
      h('h1', {}, title),
      h('p', { class: 'muted' }, first ? 'Willkommen! Du richtest den Club ein und wirst Admin.' : 'Anmelden oder mit Einladungscode beitreten.'),
      h('div', { class: 'authcard' },
        !first && h('div', { class: 'tabs-inline', style: 'margin-top:0' },
          h('button', { class: mode === 'login' ? 'on' : '', onclick: () => { mode = 'login'; drawForm(); } }, 'Anmelden'),
          h('button', { class: mode === 'register' ? 'on' : '', onclick: () => { mode = 'register'; drawForm(); } }, 'Beitreten')),
        h('form', {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api('POST', mode === 'login' ? '/api/login' : '/api/register', { name: name.value, password: pw.value, invite: invite.value });
              await load();
            } catch (x) { err.textContent = x.message; }
          },
        },
          h('label', {}, 'Name'), name,
          h('label', {}, 'Passwort' + (mode === 'register' ? ' (mind. 6 Zeichen)' : '')), pw,
          mode === 'register' && !first && [h('label', {}, 'Einladungscode'), invite],
          err,
          h('div', { class: 'wrap' }, h('button', { class: 'primary', type: 'submit' }, mode === 'login' ? 'Anmelden' : first ? 'Club gründen' : 'Beitreten')))));
  };

  (seen && !first ? drawForm : drawWelcome)();
  return box;
}

// ---------- Start ----------
function tile(cls, ic, title, sub, target) {
  return h('button', { class: `tile ${cls}`, onclick: () => go(target) },
    h('span', { class: 'chip' }, icon(ic)), h('strong', {}, title), h('small', {}, sub), h('span', { class: 'arrow' }, icon('arrow')));
}

function homeView() {
  const cur = S.books.find((b) => b.status === 'current');
  const m = nextMeeting();
  const open = S.books.filter((b) => b.status === 'suggested').length;
  const queued = S.books.filter((b) => b.status === 'queued').length;
  const upcoming = S.meetings.filter((x) => new Date(x.starts_at).getTime() + x.duration_min * 60000 > Date.now()).length;
  return [
    h('div', { class: 'hello' }, h('div', { class: 'avatar', 'aria-hidden': 'true' }, S.me.name.slice(0, 1).toUpperCase()),
      h('div', {}, h('div', { class: 'muted' }, 'Hallo'), h('strong', {}, S.me.name))),
    h('h1', { class: 'ask' }, 'Was lesen wir ', h('span', {}, 'als Nächstes?')),
    h('button', { class: 'searchbar', onclick: suggestDialog }, 'Buch suchen oder vorschlagen …', h('span', { class: 'go' }, icon('plus'))),
    h('div', { class: 'tiles' },
      tile('t1', 'bulb', 'Vorschläge', `${open} offen · abstimmen & kommentieren`, 'ideas'),
      tile('t2', 'book', 'Leseliste', `${queued} in der Warteschlange`, 'list'),
      tile('t3', 'cal', 'Termine', `${upcoming} kommend · zu- oder absagen`, 'dates'),
      tile('t4', 'users', 'Club', `${S.members.length} ${S.members.length === 1 ? 'Mitglied' : 'Mitglieder'} · Kalender-Abo`, 'club')),
    h('h2', {}, 'Wir lesen gerade'),
    cur
      ? h('div', { class: 'card hero' }, h('div', { class: 'row' }, bookCover(cur, true),
          h('div', { class: 'grow' }, h('h3', {}, cur.title), h('div', { class: 'muted' }, [cur.author, cur.year, cur.pages && `${cur.pages} Seiten`].filter(Boolean).join(' · ')),
            cur.description && h('p', { class: 'muted' }, cur.description.length > 220 ? cur.description.slice(0, 220) + '…' : cur.description))))
      : h('div', { class: 'card empty-state' }, 'Noch kein aktuelles Buch.', S.me.is_admin && h('div', { class: 'wrap', style: 'justify-content:center' }, h('button', { onclick: () => go('list') }, 'Leseliste öffnen'))),
    h('h2', {}, 'Nächstes Treffen'),
    m ? meetingCard(m) : h('div', { class: 'card empty-state' }, 'Noch kein Termin geplant.'),
    h('h2', {}, 'Kalender'),
    calendarCard(),
  ];
}

function calendarCard() {
  const url = location.origin + S.calendar_path;
  const webcal = url.replace(/^https?:/, 'webcal:');
  const isLocal = /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
  return h('div', { class: 'card' },
    h('p', { style: 'margin-top:0' }, 'Alle Termine automatisch im eigenen Kalender – aktualisiert sich von selbst, wenn der Admin etwas ändert.'),
    h('div', { class: 'wrap' },
      h('a', { class: 'btn primary', href: webcal }, '🍎 Apple Kalender / iPhone'),
      h('a', { class: 'btn', href: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`, target: '_blank', rel: 'noopener' }, 'Google Kalender / Android'),
      h('button', { onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Link kopiert'), () => toast(url)) }, '🔗 Link kopieren')),
    isLocal && h('p', { class: 'muted' }, 'Hinweis: Das Abo funktioniert nur, wenn die App von außen erreichbar ist (nicht über localhost/WLAN-Adresse).'));
}

// ---------- Termine ----------
function rsvpButtons(m) {
  const btn = (status, label) =>
    h('button', { class: 'small' + (m.my_rsvp === status ? ' on' : ''), 'aria-pressed': m.my_rsvp === status, onclick: () => act(() => api('POST', `/api/meetings/${m.id}/rsvp`, { status: m.my_rsvp === status ? null : status })) }, label);
  return h('div', { class: 'wrap' }, btn('yes', '✅ Ich komme'), btn('maybe', '🤔 Vielleicht'), btn('no', '❌ Kann nicht'));
}

function meetingCard(m, { admin = false } = {}) {
  const names = (s) => m.rsvps.filter((r) => r.status === s).map((r) => r.name);
  const yes = names('yes'), maybe = names('maybe'), no = names('no');
  const past = new Date(m.starts_at).getTime() + m.duration_min * 60000 < Date.now();
  return h('div', { class: 'card' + (m === nextMeeting() ? ' hero' : '') },
    h('div', { class: 'row' }, m.book_title && bookCover(m),
      h('div', { class: 'grow' },
        h('div', { class: 'when' }, fmtDate(m.starts_at)),
        m.location && h('div', {}, '📍 ', m.location),
        m.book_title && h('div', { class: 'muted' }, '📖 ', m.book_title, m.book_author && ` – ${m.book_author}`),
        m.notes && h('p', { class: 'muted', style: 'white-space:pre-wrap;margin:6px 0 0' }, m.notes))),
    h('div', { class: 'muted', style: 'margin-top:8px' },
      `✅ ${yes.length}${yes.length ? ': ' + yes.join(', ') : ''}`, maybe.length ? ` · 🤔 ${maybe.join(', ')}` : '', no.length ? ` · ❌ ${no.join(', ')}` : ''),
    !past && rsvpButtons(m),
    h('div', { class: 'wrap' },
      h('a', { class: 'btn small', href: `/api/meetings/${m.id}/ics` }, '📥 Apple/Android (.ics)'),
      h('a', { class: 'btn small', href: googleLink(m), target: '_blank', rel: 'noopener' }, 'Google Kalender'),
      admin && h('button', { class: 'small', onclick: () => meetingDialog(m) }, '✏️ Bearbeiten'),
      admin && h('button', { class: 'small danger', onclick: () => confirm('Termin wirklich löschen?') && act(() => api('DELETE', `/api/meetings/${m.id}`), 'Termin gelöscht') }, 'Löschen')));
}

function datesView() {
  const upcoming = S.meetings.filter((m) => new Date(m.starts_at).getTime() + m.duration_min * 60000 >= Date.now());
  const past = S.meetings.filter((m) => !upcoming.includes(m)).reverse();
  return [
    h('header', { class: 'top' }, h('h1', {}, 'Termine'), S.me.is_admin && h('button', { class: 'primary', onclick: () => meetingDialog() }, '+ Termin')),
    upcoming.length ? upcoming.map((m) => meetingCard(m, { admin: S.me.is_admin })) : h('div', { class: 'card empty-state' }, 'Keine kommenden Termine.'),
    past.length > 0 && [h('h2', {}, 'Vergangene Treffen'), past.map((m) => meetingCard(m, { admin: S.me.is_admin }))],
  ];
}

function meetingDialog(m) {
  const last = S.meetings[S.meetings.length - 1];
  const cur = S.books.find((b) => b.status === 'current');
  const when = h('input', { type: 'datetime-local', required: true, value: m ? toLocalInput(m.starts_at) : '' });
  const dur = h('input', { type: 'number', min: 15, max: 720, step: 15, value: m?.duration_min ?? 120 });
  const loc = h('input', { maxLength: 200, value: m?.location ?? last?.location ?? '', placeholder: 'z. B. Café Lesezeichen, Hauptstr. 5' });
  const notes = h('textarea', { maxLength: 2000, value: m?.notes ?? '', placeholder: 'Mitbringen, Leseabschnitt, …' });
  const books = S.books.filter((b) => ['current', 'finished'].includes(b.status) || b.id === m?.book_id);
  const sel = h('select', {}, h('option', { value: '' }, '– kein Buch –'),
    books.map((b) => h('option', { value: b.id, selected: (m ? m.book_id : cur?.id) === b.id }, `${b.title}${b.status === 'current' ? ' (aktuell)' : ''}`)));
  const err = h('p', { class: 'err', role: 'alert' });
  showDialog(
    h('h2', { style: 'margin-top:0' }, m ? 'Termin bearbeiten' : 'Neuer Termin'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const body = { starts_at: new Date(when.value).toISOString(), duration_min: Number(dur.value), location: loc.value, notes: notes.value, book_id: sel.value ? Number(sel.value) : null };
          await api(m ? 'PATCH' : 'POST', m ? `/api/meetings/${m.id}` : '/api/meetings', body);
          dlg.close();
          await load();
          toast('Termin gespeichert');
        } catch (x) { err.textContent = x.message; }
      },
    },
      h('label', {}, 'Buch'), sel, h('label', {}, 'Datum & Uhrzeit'), when, h('label', {}, 'Dauer (Minuten)'), dur,
      h('label', {}, 'Ort'), loc, h('label', {}, 'Notizen'), notes, err,
      h('div', { class: 'wrap' }, h('button', { class: 'primary', type: 'submit' }, 'Speichern'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'))));
}

// ---------- Vorschläge ----------
function ideasView() {
  const list = S.books.filter((b) => b.status === 'suggested').sort((a, b) => b.votes - a.votes || b.id - a.id);
  return [
    h('header', { class: 'top' }, h('h1', {}, 'Vorschläge'), h('button', { class: 'primary', onclick: suggestDialog }, '+ Buch')),
    h('p', { class: 'muted' }, 'Stimmt für eure Favoriten ab und diskutiert in den Kommentaren.'),
    list.length ? list.map(ideaCard) : h('div', { class: 'card empty-state' }, 'Noch keine Vorschläge. Mach den Anfang!'),
  ];
}

function ideaCard(b) {
  const open = openComments.has(b.id);
  return h('article', { class: 'card' },
    h('div', { class: 'row' }, bookCover(b),
      h('div', { class: 'grow' }, h('h3', {}, b.title),
        h('div', { class: 'muted' }, [b.author, b.year, b.pages && `${b.pages} S.`].filter(Boolean).join(' · ')),
        h('div', { class: 'muted' }, `von ${b.suggested_by_name ?? 'ehemaligem Mitglied'}`)),
      h('button', { class: 'vote' + (b.voted ? ' on' : ''), 'aria-pressed': b.voted, 'aria-label': `Abstimmen für ${b.title}`, onclick: () => act(() => api('POST', `/api/books/${b.id}/vote`, {})) },
        h('span', { 'aria-hidden': 'true' }, b.voted ? '👍' : '👍🏻'), h('strong', {}, b.votes))),
    b.description && h('details', { style: 'margin-top:8px' }, h('summary', { class: 'muted' }, 'Beschreibung'), h('p', { style: 'margin:6px 0 0' }, b.description)),
    h('div', { class: 'wrap' },
      h('button', { class: 'small', onclick: () => toggleComments(b.id) }, `💬 Kommentare (${b.comment_count})`),
      S.me.is_admin && h('button', { class: 'small', onclick: () => act(() => api('PATCH', `/api/books/${b.id}`, { status: 'queued' }), 'In die Leseliste aufgenommen') }, '➕ In Leseliste'),
      (S.me.is_admin || b.suggested_by === S.me.id) && h('button', { class: 'small danger', onclick: () => confirm(`„${b.title}“ löschen?`) && act(() => api('DELETE', `/api/books/${b.id}`), 'Vorschlag gelöscht') }, 'Löschen')),
    open && commentsBox(b));
}

async function toggleComments(id) {
  if (openComments.has(id)) openComments.delete(id);
  else {
    openComments.set(id, null);
    render();
    try { openComments.set(id, (await api('GET', `/api/books/${id}/comments`)).comments); } catch (e) { openComments.delete(id); toast(e.message); }
  }
  render();
}

function commentsBox(b) {
  const list = openComments.get(b.id);
  const input = h('textarea', { placeholder: 'Deine Meinung zum Buch …', maxLength: 2000, rows: 2, 'aria-label': 'Kommentar' });
  return h('div', { class: 'comments' },
    list === null ? h('p', { class: 'muted' }, 'Lade …')
      : list.length ? list.map((c) => h('div', { class: 'comment' },
          h('div', { class: 'muted' }, h('strong', {}, c.name), ' · ', ago(c.created_at), (c.user_id === S.me.id || S.me.is_admin) && [' · ', h('button', { class: 'small danger', style: 'border:0;padding:0 4px;min-height:0', onclick: async () => { await act(() => api('DELETE', `/api/comments/${c.id}`)); openComments.set(b.id, (await api('GET', `/api/books/${b.id}/comments`)).comments); render(); } }, 'löschen')]),
          h('p', {}, c.body)))
        : h('p', { class: 'muted' }, 'Noch keine Kommentare.'),
    input,
    h('div', { class: 'wrap' }, h('button', { class: 'small primary', onclick: async () => {
      if (!input.value.trim()) return;
      try {
        await api('POST', `/api/books/${b.id}/comments`, { body: input.value });
        const comments = (await api('GET', `/api/books/${b.id}/comments`)).comments;
        await load();
        openComments.set(b.id, comments);
        render();
      } catch (e) { toast(e.message); }
    } }, 'Senden')));
}

function suggestDialog() {
  const results = h('div');
  const status = h('p', { class: 'muted' }, 'Suche nach Titel, Autor:in oder ISBN.');
  const input = h('input', { type: 'search', placeholder: 'z. B. „Der Report der Magd“', autofocus: true, 'aria-label': 'Buchsuche' });
  let timer, seq = 0;

  const submit = async (book) => {
    try {
      await api('POST', '/api/books', book);
      dlg.close();
      await load();
      toast('Vorschlag eingereicht 🎉');
    } catch (e) { toast(e.message); }
  };

  async function search() {
    const term = input.value.trim();
    const mine = ++seq;
    if (term.length < 2) { results.replaceChildren(); status.textContent = 'Suche nach Titel, Autor:in oder ISBN.'; return; }
    status.textContent = 'Suche …';
    try {
      const { results: rs } = await api('GET', `/api/search?q=${encodeURIComponent(term)}`);
      if (mine !== seq) return;
      status.textContent = rs.length ? '' : 'Nichts gefunden – versuch es anders oder trag das Buch manuell ein.';
      results.replaceChildren(...rs.map((r) => h('div', { class: 'result' }, bookCover(r),
        h('div', { class: 'grow' }, h('strong', {}, r.title), h('div', { class: 'muted' }, [r.author, r.year].filter(Boolean).join(' · '))),
        h('button', { class: 'small primary', onclick: (e) => { e.target.disabled = true; submit(r); } }, 'Vorschlagen'))));
    } catch (e) {
      if (mine === seq) { results.replaceChildren(); status.textContent = e.message; }
    }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 350); });

  showDialog(
    h('h2', { style: 'margin-top:0' }, 'Buch vorschlagen'),
    input, status, h('div', { style: 'max-height:50vh;overflow:auto' }, results),
    h('div', { class: 'wrap' },
      h('button', { onclick: manualDialog }, '✍️ Manuell eintragen'), h('button', { onclick: () => dlg.close() }, 'Schließen')));
}

function manualDialog() {
  const f = { title: h('input', { required: true, maxLength: 300 }), author: h('input', { maxLength: 200 }), pages: h('input', { type: 'number', min: 1 }), description: h('textarea', { maxLength: 2000 }) };
  showDialog(h('h2', { style: 'margin-top:0' }, 'Buch manuell eintragen'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/books', { title: f.title.value, author: f.author.value, pages: f.pages.value, description: f.description.value });
        dlg.close(); await load(); toast('Vorschlag eingereicht 🎉');
      } catch (x) { toast(x.message); }
    } },
      h('label', {}, 'Titel'), f.title, h('label', {}, 'Autor:in'), f.author, h('label', {}, 'Seiten (optional)'), f.pages, h('label', {}, 'Worum geht es? (optional)'), f.description,
      h('div', { class: 'wrap' }, h('button', { class: 'primary', type: 'submit' }, 'Vorschlagen'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'))));
}

function showDialog(...kids) {
  dlg.replaceChildren(...kids);
  if (!dlg.open) dlg.showModal();
}

// ---------- Leseliste ----------
function listView() {
  const admin = S.me.is_admin;
  const cur = S.books.find((b) => b.status === 'current');
  const queue = S.books.filter((b) => b.status === 'queued').sort((a, b) => a.position - b.position);
  const done = S.books.filter((b) => b.status === 'finished');
  const m = nextMeeting();
  const move = (i, d) => {
    const ids = queue.map((b) => b.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    act(() => api('POST', '/api/books/reorder', { ids }));
  };
  return [
    h('header', { class: 'top' }, h('h1', {}, 'Leseliste')),
    h('h2', {}, 'Aktuell'),
    cur
      ? h('div', { class: 'card hero' }, h('div', { class: 'row' }, bookCover(cur),
          h('div', { class: 'grow' }, h('h3', {}, cur.title), h('div', { class: 'muted' }, cur.author),
            m && m.book_id === cur.id ? h('div', {}, '📅 Besprechung: ', h('span', { class: 'when' }, fmtDate(m.starts_at)), m.location && ` · ${m.location}`) : h('div', { class: 'muted' }, 'Noch kein Termin für dieses Buch.'))),
          admin && h('div', { class: 'wrap' },
            h('button', { class: 'small', onclick: () => meetingDialog() }, '📅 Termin anlegen'),
            h('button', { class: 'small', onclick: () => confirm('Buch als gelesen markieren?') && act(() => api('PATCH', `/api/books/${cur.id}`, { status: 'finished' }), 'Als gelesen markiert') }, '✔️ Abschließen')))
      : h('div', { class: 'card empty-state' }, 'Kein aktuelles Buch – wähle unten eins aus der Warteschlange.'),
    h('h2', {}, `Als Nächstes (${queue.length})`),
    queue.length ? queue.map((b, i) => h('div', { class: 'card' }, h('div', { class: 'row center' },
      h('span', { class: 'badge' }, i + 1), bookCover(b),
      h('div', { class: 'grow' }, h('strong', {}, b.title), h('div', { class: 'muted' }, b.author), h('div', { class: 'muted' }, `👍 ${b.votes}`)),
      admin && h('div', { class: 'wrap', style: 'margin:0;justify-content:flex-end' },
        h('button', { class: 'small', disabled: i === 0, 'aria-label': 'Nach oben', onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'small', disabled: i === queue.length - 1, 'aria-label': 'Nach unten', onclick: () => move(i, 1) }, '↓'))),
      admin && h('div', { class: 'wrap' },
        h('button', { class: 'small primary', onclick: () => act(() => api('PATCH', `/api/books/${b.id}`, { status: 'current' }), `„${b.title}“ ist jetzt das aktuelle Buch`) }, '▶️ Jetzt lesen'),
        h('button', { class: 'small', onclick: () => act(() => api('PATCH', `/api/books/${b.id}`, { status: 'suggested' })) }, 'Zurück zu Vorschlägen'))))
      : h('div', { class: 'card empty-state' }, admin ? 'Nimm Bücher aus den Vorschlägen in die Leseliste auf.' : 'Der Admin sortiert hier bald die nächsten Bücher ein.'),
    done.length > 0 && [h('h2', {}, `Schon gelesen (${done.length})`), done.map((b) => {
      const meet = S.meetings.filter((x) => x.book_id === b.id).pop();
      return h('div', { class: 'card' }, h('div', { class: 'row center' }, bookCover(b), h('div', { class: 'grow' }, h('strong', {}, b.title), h('div', { class: 'muted' }, b.author), meet && h('div', { class: 'muted' }, 'Besprochen: ', shortFmt.format(new Date(meet.starts_at)))),
        admin && h('button', { class: 'small', onclick: () => act(() => api('PATCH', `/api/books/${b.id}`, { status: 'current' })) }, 'Wieder aktuell')));
    })],
  ];
}

// ---------- Club ----------
function clubView() {
  const admin = S.me.is_admin;
  return [
    h('header', { class: 'top' }, h('h1', {}, 'Club')),
    h('h2', {}, `Mitglieder (${S.members.length})`),
    S.members.map((u) => h('div', { class: 'card row center' },
      h('div', { class: 'grow' }, h('strong', {}, u.name), u.is_admin && ' ', u.is_admin && h('span', { class: 'badge' }, 'Admin'), u.id === S.me.id && h('span', { class: 'muted' }, ' (du)')),
      admin && u.id !== S.me.id && h('div', { class: 'wrap', style: 'margin:0' },
        h('button', { class: 'small', onclick: () => act(() => api('PATCH', `/api/admin/members/${u.id}`, { is_admin: !u.is_admin })) }, u.is_admin ? 'Admin entziehen' : 'Zum Admin machen'),
        h('button', { class: 'small danger', onclick: () => confirm(`${u.name} aus dem Club entfernen?`) && act(() => api('DELETE', `/api/admin/members/${u.id}`), 'Mitglied entfernt') }, 'Entfernen')))),
    admin && [
      h('h2', {}, 'Neue Mitglieder einladen'),
      h('div', { class: 'card' }, h('p', { style: 'margin-top:0' }, 'Wer diesen Code kennt, kann dem Club beitreten:'), h('span', { class: 'code' }, S.invite_code),
        h('div', { class: 'wrap' },
          h('button', { class: 'small', onclick: () => navigator.share ? navigator.share({ title: S.club_name, text: `Tritt unserem Buchclub bei: ${location.origin} – Einladungscode: ${S.invite_code}` }).catch(() => {}) : navigator.clipboard?.writeText(`${location.origin} – Einladungscode: ${S.invite_code}`).then(() => toast('Einladung kopiert')) }, '📤 Teilen'),
          h('button', { class: 'small', onclick: () => confirm('Neuer Code? Der alte wird ungültig.') && act(() => api('POST', '/api/admin/invite', {}), 'Neuer Code erstellt') }, '🔄 Neuer Code'))),
      h('h2', {}, 'Clubname'),
      (() => {
        const input = h('input', { value: S.club_name, maxLength: 60, 'aria-label': 'Clubname' });
        return h('div', { class: 'card row center' }, h('div', { class: 'grow' }, input), h('button', { onclick: () => act(() => api('PATCH', '/api/admin/club', { club_name: input.value }), 'Gespeichert') }, 'Speichern'));
      })(),
    ],
    h('h2', {}, 'Kalender'), calendarCard(),
    h('h2', {}, 'Konto'),
    h('button', { onclick: async () => { await api('POST', '/api/logout', {}).catch(() => {}); openComments.clear(); await load(); } }, 'Abmelden'),
  ];
}

dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
load().catch(() => { app.textContent = 'Server nicht erreichbar.'; });
