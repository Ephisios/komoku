'use strict';

/* ============================================================== état */

const POLL_MS = 20000;

const state = {
  machines: [],
  now: Date.now(),
  lastOk: 0,
  loading: false,
  query: '',
  filter: 'all',
  view: 'topo',
  sort: { key: 'hostname', dir: 1 },
  selected: null,
  historyHours: 24,
  historyCache: new Map(),
};

const SERIES = [
  { key: 'cpu', label: 'Processeur', color: 'var(--series-1)' },
  { key: 'ram', label: 'Mémoire', color: 'var(--series-2)' },
  { key: 'gpu', label: 'Carte graphique', color: 'var(--series-3)' },
];

/* ============================================================ outils */

const $ = (sel, root = document) => root.querySelector(sel);

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function icon(name, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

function fmtPct(v) {
  return v === null || v === undefined ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')} %`;
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

function fmtClock(ts) {
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Seuils alignés sur ceux du serveur (lib/health.js), pour dire la même chose. */
function level(kind, v) {
  if (v === null || v === undefined) return 'idle';
  if (kind === 'disk') return v >= 95 ? 'critical' : v >= 85 ? 'warning' : 'ok';
  if (kind === 'ram') return v >= 95 ? 'critical' : v >= 88 ? 'warning' : 'ok';
  if (kind === 'cpu') return v >= 92 ? 'warning' : 'ok';
  return 'ok';
}

const SEV_ICON = { ok: 'ok', info: 'info', warning: 'warn', critical: 'crit' };
const SEV_LABEL = { ok: 'Normal', info: 'À noter', warning: 'Attention', critical: 'Problème' };

function mainDisk(m) {
  const vols = m.payload?.disk?.volumes || [];
  return vols.find((v) => /^C:/i.test(v.drive)) || vols[0] || null;
}

function primaryIp(m) {
  const ifaces = m.payload?.network?.interfaces || [];
  const withGw = ifaces.find((i) => (i.gateway || []).length > 0);
  const chosen = withGw || ifaces[0];
  return chosen?.ipv4?.[0] || null;
}

/* ========================================================== chargement */

async function fetchMachines() {
  state.loading = true;
  paintRefresh();
  try {
    const res = await fetch('api/machines', { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
      window.location.replace('login.html');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.machines = data.machines;
    state.now = data.now;
    state.lastOk = Date.now();
  } catch (err) {
    console.error('[komoku] récupération impossible', err);
  } finally {
    state.loading = false;
    render();
  }
}

async function fetchHistory(id, hours) {
  const key = `${id}:${hours}`;
  const cached = state.historyCache.get(key);
  if (cached && Date.now() - cached.at < 30000) return cached.points;
  const res = await fetch(`api/machines/${encodeURIComponent(id)}/history?hours=${hours}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.historyCache.set(key, { at: Date.now(), points: data.points });
  return data.points;
}

/* ============================================================== rendu */

function paintRefresh() {
  const box = $('#refresh');
  const label = $('#refresh-label');
  const stale = state.lastOk && Date.now() - state.lastOk > POLL_MS * 3;
  box.classList.toggle('is-loading', state.loading);
  box.classList.toggle('is-stale', Boolean(stale));
  label.textContent = state.loading
    ? 'actualisation…'
    : state.lastOk
      ? `à jour ${relTime(state.lastOk)}`
      : 'connexion…';
}

function visibleMachines() {
  const q = state.query.trim().toLowerCase();
  return state.machines.filter((m) => {
    if (state.filter === 'offline' && !m.health.offline) return false;
    if (state.filter === 'alert' && !['critical', 'warning'].includes(m.health.status)) return false;
    if (state.filter === 'alert' && m.health.offline) return false;
    if (state.filter === 'online' && m.health.offline) return false;
    if (!q) return true;
    const hay = [
      m.hostname, m.label, m.payload?.system?.loggedUser, m.payload?.system?.model,
      primaryIp(m), m.payload?.network?.publicIp, m.payload?.vpn?.name,
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderTiles() {
  const all = state.machines;
  const offline = all.filter((m) => m.health.offline);
  const alert = all.filter((m) => !m.health.offline && ['critical', 'warning'].includes(m.health.status));
  const online = all.filter((m) => !m.health.offline);
  const healthy = online.filter((m) => !['critical', 'warning'].includes(m.health.status));

  const tiles = [
    { id: 'all', n: all.length, k: 'Postes suivis', ic: 'laptop', sev: null },
    { id: 'online', n: healthy.length, k: 'En bonne santé', ic: 'ok', sev: healthy.length ? 'good' : null },
    { id: 'alert', n: alert.length, k: 'À surveiller', ic: 'warn', sev: alert.length ? 'warning' : null },
    { id: 'offline', n: offline.length, k: 'Hors ligne', ic: 'offline', sev: offline.length ? 'critical' : null },
  ];

  $('#tiles').innerHTML = tiles.map((t) => `
    <button class="tile" type="button" data-tile="${t.id}"
            aria-pressed="${state.filter === t.id}" ${t.sev ? `data-sev="${t.sev}"` : ''}>
      <div class="n">${t.n}</div>
      <div class="k">${icon(t.ic)}${t.k}</div>
    </button>`).join('');
}

function meter(kind, label, iconName, value, sub) {
  const lv = level(kind, value);
  const width = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, value));
  return `
    <div class="meter">
      <div class="meter-head">
        <span class="meter-label">${icon(iconName)}${esc(label)}</span>
        <span class="meter-value">${fmtPct(value)}</span>
      </div>
      <div class="meter-track" role="img" aria-label="${esc(label)} : ${fmtPct(value)}">
        <div class="meter-fill" data-level="${lv === 'ok' ? '' : lv}" style="width:${width}%"></div>
      </div>
      ${sub ? `<div class="meter-sub">${esc(sub)}</div>` : ''}
    </div>`;
}

function statusChip(health) {
  const sev = health.offline ? 'critical' : health.status;
  const name = health.offline ? 'Hors ligne' : SEV_LABEL[sev];
  const ic = health.offline ? 'offline' : SEV_ICON[sev];
  return `<span class="chip" data-sev="${sev}">${icon(ic)}${name}</span>`;
}

function cardFacts(m) {
  const p = m.payload || {};
  const out = [];
  const ip = primaryIp(m);
  if (ip) out.push(`<span class="fact mono">${icon('net')}${esc(ip)}</span>`);

  // Sur un poste muet, VPN, batterie et redémarrage ne décrivent plus rien
  // d'actuel : mieux vaut ne rien affirmer que d'afficher un état périmé.
  if (m.health.offline) return out.join('');

  const vpn = p.vpn || {};
  out.push(vpn.connected
    ? `<span class="fact" data-sev="good">${icon('vpn')}VPN ${esc(vpn.name || 'actif')}</span>`
    : `<span class="fact">${icon('vpn-off')}Pas de VPN</span>`);

  if (p.battery && !p.battery.onAc) {
    const sev = p.battery.percent <= 20 ? 'warning' : null;
    out.push(`<span class="fact" ${sev ? `data-sev="${sev}"` : ''}>${icon('battery')}${p.battery.percent} %</span>`);
  }
  if (p.rebootPending) {
    out.push(`<span class="fact" data-sev="warning">${icon('reboot')}Redémarrage requis</span>`);
  }
  return out.join('');
}

function renderCards(list) {
  if (!list.length) return renderEmpty();
  return `<div class="grid">${list.map((m) => {
    const p = m.payload || {};
    const disk = mainDisk(m);
    const user = (p.system?.loggedUser || '').split('\\').pop();
    const sub = [user, p.system?.model].filter(Boolean).join(' · ');

    return `
    <button class="card${m.health.offline ? ' is-offline' : ''}" type="button" data-id="${esc(m.id)}"
            data-sev="${m.health.offline ? 'critical' : m.health.status}">
      <div class="card-head">
        <div class="card-id">
          <div class="name">${esc(m.label || m.hostname)}</div>
          <div class="sub">${esc(sub || m.hostname)}</div>
        </div>
        ${statusChip(m.health)}
      </div>

      ${m.health.offline ? `
        <div class="issues">
          <div class="issue" data-sev="critical">${icon('offline')}
            <div><b>Aucun signe de vie</b> <span>— dernier contact ${esc(relTime(m.lastSeen))}</span></div>
          </div>
        </div>` : `
        <div class="meters">
          ${meter('cpu', 'Processeur', 'cpu', p.cpu?.loadPercent, p.cpu?.name)}
          ${meter('ram', 'Mémoire', 'ram', p.memory?.usedPercent,
            `${fmtBytes(p.memory?.usedBytes)} sur ${fmtBytes(p.memory?.totalBytes)}`)}
          ${disk ? meter('disk', `Disque ${disk.drive}`, 'disk', disk.usedPercent,
            `${fmtBytes(disk.freeBytes)} libres sur ${fmtBytes(disk.totalBytes)}`) : ''}
        </div>`}

      <div class="facts">${cardFacts(m)}</div>
    </button>`;
  }).join('')}</div>`;
}

/* ======================================== bandeau + carte du parc */

const SEV_RANK = { critical: 3, warning: 2, info: 1, ok: 0 };

/** Les postes en difficulté passent devant : c'est ce qu'on vient regarder. */
function byUrgency(a, b) {
  const d = SEV_RANK[b.health.status] - SEV_RANK[a.health.status];
  if (d) return d;
  return (a.label || a.hostname).localeCompare(b.label || b.hostname, 'fr');
}

function railRow(m) {
  const p = m.payload || {};
  const d = mainDisk(m);
  const off = m.health.offline;
  const sev = off ? 'critical' : m.health.status;

  const val = (kind, v) => (off || v === null || v === undefined
    ? '<span class="dim">—</span>'
    : `<b data-level="${level(kind, v)}">${Math.round(v)}<span class="u">%</span></b>`);

  const resume = off
    ? 'Hors ligne'
    : (m.health.issues[0] ? `${m.health.issues[0].label} — ${m.health.issues[0].detail}` : 'Rien à signaler');

  return `<button class="rail-row" type="button" data-id="${esc(m.id)}"
            title="${esc(`${m.label || m.hostname} · ${resume}`)}">
    <span class="led" data-sev="${sev}">${icon(off ? 'offline' : SEV_ICON[sev])}</span>
    <span class="rail-name">${esc(m.label || m.hostname)}</span>
    <span class="rail-user">${esc((p.system?.loggedUser || '').split('\\').pop() || '—')}</span>
    <span class="r">${val('cpu', p.cpu?.loadPercent)}</span>
    <span class="r">${val('ram', p.memory?.usedPercent)}</span>
    <span class="r">${val('disk', d?.usedPercent)}</span>
    <span class="rail-vpn">${off
      ? '<span class="dim">—</span>'
      : `<span class="led" data-sev="${p.vpn?.connected ? 'ok' : 'off'}"
           title="${p.vpn?.connected ? esc(`VPN ${p.vpn.name}`) : 'Aucun VPN actif'}">${
          icon(p.vpn?.connected ? 'vpn' : 'vpn-off')}</span>`}</span>
    <span class="rail-seen" data-seen="${m.lastSeen}">${esc(relTime(m.lastSeen))}</span>
  </button>`;
}

function renderTopo(list) {
  if (!list.length) return renderEmpty();
  const sorted = [...list].sort(byUrgency);

  return `
    <section class="rail" aria-label="État des postes, une ligne par poste">
      <!-- Les classes rail-user et rail-vpn doivent être AUSSI sur l'en-tête :
           c'est elles que la règle mobile masque. Sans elles, l'en-tête garde
           huit cellules là où les lignes n'en ont plus que six, et toutes les
           colonnes se décalent. -->
      <div class="rail-row rail-head">
        <span><span class="sr-only">État</span></span>
        <span>Poste</span><span class="rail-user">Utilisateur</span>
        <span class="r">CPU</span><span class="r">RAM</span><span class="r">Disque</span>
        <span class="rail-vpn">VPN</span>
        <span class="rail-seen">Vu</span>
      </div>
      ${sorted.map(railRow).join('')}
    </section>

    <section class="topo-wrap">
      <div class="topo-head">
        <h2>Carte du parc</h2>
        <div class="topo-legend">
          <span style="color:var(--good)"><i></i><span style="color:var(--text-secondary)">Normal</span></span>
          <span style="color:var(--warning)"><i></i><span style="color:var(--text-secondary)">Attention</span></span>
          <span style="color:var(--critical)"><i></i><span style="color:var(--text-secondary)">Problème</span></span>
          <span style="color:var(--text-muted)"><i></i><span style="color:var(--text-secondary)">Hors ligne</span></span>
        </div>
      </div>
      <div class="topo" id="topo" aria-label="Carte du parc : chaque poste relié au serveur">
        <div class="topo-canvas">
          <svg class="topo-links" aria-hidden="true"></svg>
          <div class="topo-nodes"></div>
        </div>
      </div>
    </section>`;
}

/** Répartit n postes sur un ou plusieurs anneaux : 9 sur le premier, puis +6. */
function ringPlan(n) {
  const rings = [];
  let left = n;
  let i = 0;
  while (left > 0) {
    const capacity = Math.min(left, 9 + i * 6);
    rings.push(capacity);
    left -= capacity;
    i += 1;
  }
  return rings;
}

const LINK_COLOR = {
  ok: 'var(--good)',
  info: 'var(--good)',
  warning: 'var(--warning)',
  critical: 'var(--critical)',
};

function drawTopology(list) {
  const host = $('#topo');
  if (!host) return;

  const sorted = [...list].sort(byUrgency);
  const rings = ringPlan(sorted.length);
  const height = 390 + (rings.length - 1) * 175;
  host.style.height = `${height}px`;

  // En dessous de 720 px le plan ne se comprime pas : il défile.
  const w = Math.max(host.clientWidth, 720);
  host.style.setProperty('--topo-w', `${w}px`);
  const h = height;
  const cx = w / 2;
  const cy = h / 2;

  // Rayons : il faut la place d'une demi-carte (87 px) plus une marge de
  // respiration, sinon les nœuds de gauche et de droite frôlent le bord.
  const maxRx = Math.max(150, w / 2 - 118);
  const maxRy = Math.max(112, h / 2 - 44);

  const nodes = [];
  let index = 0;
  rings.forEach((capacity, ri) => {
    const t = rings.length === 1 ? 1 : (ri + 1) / rings.length;
    const rx = maxRx * (0.62 + 0.38 * t);
    const ry = maxRy * (0.62 + 0.38 * t);
    // Un anneau sur deux est décalé d'un demi-pas : les cartes ne s'alignent
    // pas radialement et ne se masquent pas entre elles.
    const shift = ri % 2 ? Math.PI / capacity : 0;
    for (let i = 0; i < capacity; i += 1) {
      const angle = -Math.PI / 2 + (i / capacity) * Math.PI * 2 + shift;
      nodes.push({
        m: sorted[index],
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry,
      });
      index += 1;
    }
  });

  const svg = $('.topo-links', host);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = nodes.map((n, i) => {
    const off = n.m.health.offline;
    const color = off ? 'var(--text-muted)' : LINK_COLOR[n.m.health.status];
    const dx = n.x - cx;
    const dy = n.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    // Courbure constante perpendiculaire au trait : des arcs réguliers,
    // plus lisibles qu'un faisceau de droites.
    const bend = 20;
    const qx = (cx + n.x) / 2 - (dy / len) * bend;
    const qy = (cy + n.y) / 2 + (dx / len) * bend;
    return `<path data-link="${i}" class="${off ? 'down' : 'live'}" stroke="${color}"
             d="M${cx.toFixed(1)},${cy.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${n.x.toFixed(1)},${n.y.toFixed(1)}"/>`;
  }).join('');

  const alerts = sorted.filter((m) => ['critical', 'warning'].includes(m.health.status)).length;
  const bar = (kind, v) => {
    const width = v === null || v === undefined ? 0 : Math.max(0, Math.min(100, v));
    return `<span class="tn-bar"><i data-level="${level(kind, v)}" style="width:${width}%"></i></span>`;
  };

  $('.topo-nodes', host).innerHTML = `
    <div class="topo-hub" style="left:${cx}px;top:${cy}px">
      <span class="hub-mark">${icon('net')}</span>
      <span>
        <span class="hub-name">Komoku</span>
        <span class="hub-sub">${sorted.length} poste${sorted.length > 1 ? 's' : ''}${
          alerts ? ` · ${alerts} à surveiller` : ' · tout va bien'}</span>
      </span>
    </div>
    ${nodes.map((n, i) => {
      const m = n.m;
      const p = m.payload || {};
      const d = mainDisk(m);
      const off = m.health.offline;
      const sev = off ? 'critical' : m.health.status;
      return `<button class="topo-node${off ? ' is-down' : ''}" type="button"
                data-id="${esc(m.id)}" data-link="${i}" data-sev="${sev}"
                style="left:${n.x.toFixed(1)}px;top:${n.y.toFixed(1)}px"
                title="${esc(`${m.hostname} · ${off ? 'hors ligne' : `CPU ${fmtPct(p.cpu?.loadPercent)} · RAM ${fmtPct(p.memory?.usedPercent)} · disque ${fmtPct(d?.usedPercent)}`}`)}">
        <span class="tn-head">
          <span class="led" data-sev="${sev}">${icon(off ? 'offline' : SEV_ICON[sev])}</span>
          <span class="tn-name">${esc(m.label || m.hostname)}</span>
        </span>
        ${off ? '' : `<span class="tn-bars">
          ${bar('cpu', p.cpu?.loadPercent)}${bar('ram', p.memory?.usedPercent)}${bar('disk', d?.usedPercent)}
        </span>`}
      </button>`;
    }).join('')}`;

  // Survol d'une carte : son lien ressort du faisceau.
  for (const node of host.querySelectorAll('.topo-node')) {
    const link = svg.querySelector(`path[data-link="${node.dataset.link}"]`);
    if (!link) continue;
    node.addEventListener('pointerenter', () => link.classList.add('hot'));
    node.addEventListener('pointerleave', () => link.classList.remove('hot'));
  }
}

/**
 * Les mesures d'un poste hors ligne sont périmées : la table les affiche « — »,
 * et `live` les rend nulles au tri pour que ces postes tombent en bas du
 * classement plutôt que de s'intercaler sur une valeur qu'on ne voit pas.
 */
const live = (fn) => (m) => (m.health.offline ? null : fn(m));

const COLUMNS = [
  { key: 'hostname', label: 'Poste', get: (m) => m.label || m.hostname },
  { key: 'user', label: 'Utilisateur', get: (m) => (m.payload?.system?.loggedUser || '').split('\\').pop() },
  { key: 'status', label: 'État', get: (m) => m.health.status, num: false },
  { key: 'cpu', label: 'CPU', get: live((m) => m.payload?.cpu?.loadPercent), num: true },
  { key: 'ram', label: 'RAM', get: live((m) => m.payload?.memory?.usedPercent), num: true },
  { key: 'disk', label: 'Disque', get: live((m) => mainDisk(m)?.usedPercent), num: true },
  { key: 'free', label: 'Libre', get: live((m) => mainDisk(m)?.freeBytes), num: true },
  { key: 'vpn', label: 'VPN', get: live((m) => (m.payload?.vpn?.connected ? 1 : 0)) },
  { key: 'ip', label: 'IP locale', get: (m) => primaryIp(m) },
  { key: 'seen', label: 'Vu', get: (m) => m.lastSeen, num: true },
];

function renderTable(list) {
  if (!list.length) return renderEmpty();
  const { key, dir } = state.sort;
  const col = COLUMNS.find((c) => c.key === key) || COLUMNS[0];
  const sorted = [...list].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'fr')) * dir;
  });

  const head = COLUMNS.map((c) => {
    const sortAttr = c.key === key ? (dir === 1 ? 'ascending' : 'descending') : 'none';
    return `<th aria-sort="${sortAttr}" data-sort="${c.key}" scope="col">${esc(c.label)}</th>`;
  }).join('');

  const body = sorted.map((m) => {
    const p = m.payload || {};
    const disk = mainDisk(m);
    return `<tr data-id="${esc(m.id)}">
      <td><strong>${esc(m.label || m.hostname)}</strong></td>
      <td>${esc((p.system?.loggedUser || '—').split('\\').pop())}</td>
      <td>${statusChip(m.health)}</td>
      <td class="num">${m.health.offline ? '—' : fmtPct(p.cpu?.loadPercent)}</td>
      <td class="num">${m.health.offline ? '—' : fmtPct(p.memory?.usedPercent)}</td>
      <td class="num">${m.health.offline ? '—' : fmtPct(disk?.usedPercent)}</td>
      <td class="num">${m.health.offline ? '—' : fmtBytes(disk?.freeBytes)}</td>
      <td>${m.health.offline ? '—' : p.vpn?.connected
        ? `<span class="fact" data-sev="good">${icon('vpn')}${esc(p.vpn.name || 'actif')}</span>`
        : `<span class="fact">${icon('vpn-off')}non</span>`}</td>
      <td class="mono">${esc(primaryIp(m) || '—')}</td>
      <td data-seen="${m.lastSeen}">${esc(relTime(m.lastSeen))}</td>
    </tr>`;
  }).join('');

  return `<div class="table-wrap"><table>
    <caption class="sr-only">Liste des postes suivis, triable par colonne</caption>
    <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderEmpty() {
  if (state.machines.length === 0) {
    return `<div class="empty">
      <h2>Aucun poste ne s'est encore signalé</h2>
      <p>Installe l'agent sur un PC avec <code>install.ps1</code>, puis patiente quelques minutes.</p>
    </div>`;
  }
  return `<div class="empty"><h2>Aucun poste ne correspond</h2>
    <p>Modifie la recherche ou le filtre.</p></div>`;
}

let lastRenderSig = null;

function render({ force = false } = {}) {
  paintRefresh();
  renderTiles();
  $('#brand-sub').textContent =
    `${state.machines.length} poste${state.machines.length > 1 ? 's' : ''}`;

  const list = visibleMachines();

  // Reconstruire le DOM toutes les 20 s relancerait l'animation des liens et
  // couperait un survol en cours, pour rien : on ne redessine que si une
  // donnée affichée a changé. Les « il y a 3 min » ne comptent pas — ils sont
  // rafraîchis sur place par tickRelativeTimes, sans toucher au reste.
  const sig = [
    state.view, state.filter, state.query, state.sort.key, state.sort.dir,
    ...list.map((m) => `${m.id}|${m.health.status}|${m.lastSeen}`),
  ].join('~');

  if (!force && sig === lastRenderSig) {
    if (state.selected) refreshDrawer();
    return;
  }
  lastRenderSig = sig;

  $('#main').innerHTML = state.view === 'topo' ? renderTopo(list)
    : state.view === 'cards' ? renderCards(list)
      : renderTable(list);

  if (state.view === 'topo') drawTopology(list);
  if (state.selected) refreshDrawer();
}

/* ========================================================== graphique */

/**
 * Courbe multi-séries sur un axe unique (tout est en pourcentage).
 * Repères discrets, libellés directs en bout de ligne, croix de visée au survol.
 */
function drawChart(box, points, opts = {}) {
  const width = box.clientWidth || 640;
  const height = opts.height || 190;
  const M = { top: 12, right: 52, bottom: 22, left: 32 };
  const iw = Math.max(40, width - M.left - M.right);
  const ih = height - M.top - M.bottom;

  if (!points.length) {
    box.innerHTML = `<p class="meter-sub" style="padding:24px 0;text-align:center">
      Pas encore assez de mesures pour tracer une courbe.</p>`;
    return;
  }

  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const x = (ts) => M.left + ((ts - t0) / span) * iw;
  const y = (v) => M.top + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;

  // Une interruption dans les mesures ne doit pas être reliée par un trait droit.
  const gaps = [];
  for (let i = 1; i < points.length; i += 1) gaps.push(points[i].ts - points[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const maxGap = Math.max(median * 3, 300000);

  const paths = SERIES.map((s) => {
    const segments = [];
    let cur = [];
    points.forEach((p, i) => {
      const v = p[s.key];
      const broke = i > 0 && points[i].ts - points[i - 1].ts > maxGap;
      if (v === null || v === undefined || broke) {
        if (cur.length > 1) segments.push(cur);
        cur = [];
      }
      if (v !== null && v !== undefined) cur.push(`${x(p.ts).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (cur.length > 1) segments.push(cur);
    return { ...s, d: segments.map((seg) => `M${seg.join('L')}`).join(' ') };
  });

  const gridY = [0, 25, 50, 75, 100];
  const ticks = 4;
  const timeTicks = Array.from({ length: ticks + 1 }, (_, i) => t0 + (span * i) / ticks);

  // Libellés directs, décalés quand deux lignes finissent au même endroit
  const ends = SERIES.map((s) => {
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const v = points[i][s.key];
      if (v !== null && v !== undefined) return { ...s, v, y: y(v) };
    }
    return null;
  }).filter(Boolean).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) {
    if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  }

  box.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" height="${height}" role="img"
         aria-label="Charge du poste sur la période choisie">
      <g stroke="var(--border)" stroke-width="1">
        ${gridY.map((v) => `<line x1="${M.left}" x2="${M.left + iw}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}
      </g>
      <g fill="var(--text-muted)" font-size="10" text-anchor="end" font-variant-numeric="tabular-nums">
        ${gridY.map((v) => `<text x="${M.left - 7}" y="${y(v) + 3.5}">${v}</text>`).join('')}
      </g>
      <g fill="var(--text-muted)" font-size="10" text-anchor="middle">
        ${timeTicks.map((t, i) => `<text x="${
          Math.min(Math.max(x(t), M.left + 14), M.left + iw - 14)
        }" y="${height - 6}">${new Date(t).toLocaleTimeString('fr-FR', {
          hour: '2-digit', minute: '2-digit',
        })}</text>`).join('')}
      </g>
      <g fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${paths.map((p) => `<path d="${p.d}" stroke="${p.color}"/>`).join('')}
      </g>
      <g font-size="10.5" font-weight="600" font-variant-numeric="tabular-nums">
        ${ends.map((e) => `<text x="${M.left + iw + 6}" y="${e.y + 3.5}" fill="${e.color}">${
          Math.round(e.v)}%</text>`).join('')}
      </g>
      <line class="crosshair" x1="0" x2="0" y1="${M.top}" y2="${M.top + ih}"
            stroke="var(--border-strong)" stroke-width="1" opacity="0"/>
      <g class="cross-dots"></g>
      <rect class="hit" x="${M.left}" y="${M.top}" width="${iw}" height="${ih}" fill="transparent"/>
    </svg>
    <div class="tooltip"></div>`;

  const svg = $('svg', box);
  const hair = $('.crosshair', box);
  const dots = $('.cross-dots', box);
  const tip = $('.tooltip', box);

  function hide() {
    hair.setAttribute('opacity', '0');
    dots.innerHTML = '';
    tip.classList.remove('on');
  }

  function move(ev) {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * width;
    const ts = t0 + ((px - M.left) / iw) * span;

    let best = points[0];
    let bestD = Infinity;
    for (const p of points) {
      const d = Math.abs(p.ts - ts);
      if (d < bestD) { bestD = d; best = p; }
    }

    const bx = x(best.ts);
    hair.setAttribute('x1', bx);
    hair.setAttribute('x2', bx);
    hair.setAttribute('opacity', '1');

    dots.innerHTML = SERIES
      .filter((s) => best[s.key] !== null && best[s.key] !== undefined)
      .map((s) => `<circle cx="${bx}" cy="${y(best[s.key])}" r="4"
                    fill="${s.color}" stroke="var(--surface-1)" stroke-width="2"/>`)
      .join('');

    tip.innerHTML = `<div class="t-time">${esc(fmtClock(best.ts))}</div>` + SERIES.map((s) => `
      <div class="t-row">
        <span class="t-key" style="color:${s.color}"><i></i><span style="color:var(--text-secondary)">${
          esc(s.label)}</span></span>
        <b>${best[s.key] === null || best[s.key] === undefined ? '—' : fmtPct(best[s.key])}</b>
      </div>`).join('');

    const scale = r.width / width;
    const left = bx * scale + 14;
    tip.style.left = `${Math.min(left, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = '6px';
    tip.classList.add('on');
  }

  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', hide);
}

/* ============================================================== volet */

/**
 * Prévision de saturation du disque.
 *
 * Quand le serveur refuse de prévoir, on affiche le motif plutôt que rien :
 * « pas assez de mesures » et « occupation stable » n'appellent pas la même
 * réaction, et une case vide laisserait croire à une panne de l'outil.
 */
function forecastLine(m) {
  const f = m.forecast;
  if (!f) return '';

  if (!f.possible) {
    return `<p class="meter-sub" style="margin-top:10px">
      ${icon('clock')} Prévision : ${esc(f.raison || 'indisponible')}
      ${f.points ? `<span class="dim"> · ${f.points} mesures</span>` : ''}
    </p>`;
  }

  const j = f.joursRestants;
  const sev = j <= 7 ? 'critical' : j <= 21 ? 'warning' : 'info';
  const quand = j < 1 ? "aujourd'hui" : j < 2 ? 'demain' : `dans ${Math.round(j)} jours`;
  return `<div class="facts" style="margin-top:10px">
    <span class="fact" data-sev="${sev}">${icon('clock')}Disque plein ${esc(quand)}</span>
    <span class="fact">${icon('disk')}+${esc(String(f.penteParJour).replace('.', ','))} %/jour</span>
    <span class="fact" title="Qualité de l'ajustement : 1 = progression parfaitement régulière">
      fiabilité ${esc(String(Math.round(f.r2 * 100)))} %</span>
  </div>`;
}

function panel(title, inner) {
  return `<section class="panel"><h3>${esc(title)}</h3>${inner}</section>`;
}

function kv(pairs) {
  const rows = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!rows.length) return '<p class="meter-sub">Aucune donnée.</p>';
  return `<dl class="kv">${rows.map(([k, v, mono]) =>
    `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${v}</dd>`).join('')}</dl>`;
}

function drawerContent(m) {
  const p = m.payload || {};
  const sec = p.security || {};
  const parts = [];

  if (m.health.issues.length) {
    parts.push(panel('Points d\u2019attention', `<div class="issues">${m.health.issues.map((i) => `
      <div class="issue" data-sev="${i.severity}">${icon(SEV_ICON[i.severity])}
        <div><b>${esc(i.label)}</b> <span>— ${esc(i.detail)}</span></div>
      </div>`).join('')}</div>`));
  }

  const ranges = [6, 24, 168];
  parts.push(panel('Charge dans le temps', `
    <div class="chart-head">
      <div class="legend">${SERIES.map((s) =>
        `<span style="color:${s.color}"><i></i><span style="color:var(--text-secondary)">${
          esc(s.label)}</span></span>`).join('')}</div>
      <div class="seg" role="group" aria-label="Période">
        ${ranges.map((h) => `<button type="button" data-range="${h}"
          aria-pressed="${state.historyHours === h}">${h < 24 ? `${h} h` : h === 24 ? '24 h' : '7 j'}</button>`).join('')}
      </div>
    </div>
    <div class="chart-box" id="chart"></div>`));

  const vols = p.disk?.volumes || [];
  parts.push(panel('Stockage', `
    <div class="meters">${vols.map((v) => meter('disk', `${v.drive} ${v.label || ''}`.trim(), 'disk',
      v.usedPercent, `${fmtBytes(v.freeBytes)} libres sur ${fmtBytes(v.totalBytes)} · ${v.fileSystem || ''}`)).join('')}</div>
    ${forecastLine(m)}
    ${(p.disk?.physical || []).length ? `<div class="facts">${p.disk.physical.map((d) => {
      const bad = d.healthStatus && !/healthy|sain/i.test(d.healthStatus);
      return `<span class="fact" ${bad ? 'data-sev="critical"' : ''}>${icon('disk')}${
        esc(d.name)} · ${esc(d.mediaType)} · ${fmtBytes(d.sizeBytes)} · ${esc(d.healthStatus)}</span>`;
    }).join('')}</div>` : ''}`));

  const vpn = p.vpn || {};
  parts.push(panel('Réseau et VPN', `
    ${kv([
      ['VPN', vpn.connected
        ? `<span class="fact" data-sev="good">${icon('vpn')}Connecté — ${esc(vpn.name)}</span>`
        : `<span class="fact">${icon('vpn-off')}Aucun tunnel actif</span>`],
      ['IP publique', esc(p.network?.publicIp), true],
      ['Passerelle', esc(p.network?.gateway), true],
      ['Wi-Fi', esc(p.network?.wifiSsid)],
    ])}
    <div class="facts">${(p.network?.interfaces || []).map((i) =>
      `<span class="fact mono">${icon('net')}${esc(i.alias)} · ${esc((i.ipv4 || []).join(', '))}${
        i.linkSpeed ? ` · ${esc(i.linkSpeed)}` : ''}</span>`).join('')}</div>
    ${(vpn.details || []).length ? `<div class="facts">${vpn.details.map((d) =>
      `<span class="fact">${icon('shield')}${esc(d.name)} · ${esc(d.source)} · ${esc(d.status)}</span>`).join('')}</div>` : ''}`));

  const av = sec.antivirus || [];
  parts.push(panel('Sécurité', kv([
    ['Antivirus', av.length
      ? av.map((a) => `<span class="fact" data-sev="${a.realTime ? 'good' : 'critical'}">${
          icon('shield')}${esc(a.name)} — ${a.realTime ? 'temps réel actif' : 'inactif'}${
          a.upToDate ? '' : ', signatures anciennes'}</span>`).join(' ')
      : null],
    ['Pare-feu', (sec.firewall || []).length
      ? sec.firewall.map((f) => `<span class="fact" data-sev="${f.enabled ? 'good' : 'warning'}">${
          icon('shield')}${esc(f.name)} ${f.enabled ? 'activé' : 'désactivé'}</span>`).join(' ')
      : null],
    ['BitLocker', (sec.bitlocker || []).length
      ? sec.bitlocker.map((b) => `<span class="fact">${esc(b.mount)} ${esc(b.protection)} (${b.percent} %)</span>`).join(' ')
      : null],
    ['Dernier correctif', sec.lastUpdate
      ? `${esc(sec.lastUpdate.id)} — ${esc(new Date(sec.lastUpdate.date).toLocaleDateString('fr-FR'))}` : null],
    ['Redémarrage', p.rebootPending
      ? `<span class="fact" data-sev="warning">${icon('reboot')}en attente</span>` : 'à jour'],
  ])));

  const gpus = p.gpu?.adapters || [];
  parts.push(panel('Matériel et système', kv([
    ['Nom réseau', esc(m.hostname), true],
    ['Utilisateur', esc(p.system?.loggedUser)],
    ['Modèle', esc([p.system?.manufacturer, p.system?.model].filter(Boolean).join(' '))],
    ['Numéro de série', esc(p.system?.serial), true],
    ['Système', esc([p.system?.osName, p.system?.osDisplayVersion].filter(Boolean).join(' · '))],
    ['Build', esc(p.system?.osBuild), true],
    ['Processeur', esc(p.cpu?.name) + (p.cpu?.cores ? ` — ${p.cpu.cores} cœurs / ${p.cpu.threads} threads` : '')],
    ['Mémoire', fmtBytes(p.memory?.totalBytes)],
    ['Carte graphique', gpus.map((g) =>
      `${esc(g.name)}${g.vramBytes ? ` (${fmtBytes(g.vramBytes)})` : ''}`).join('<br>') || null],
    ['Allumé depuis', fmtDuration(p.system?.uptimeSeconds)],
    ['Domaine', esc(p.system?.domain)],
    ['Identifiant Komoku', esc(m.id), true],
    ['Version de l\u2019agent', esc(p.agentVersion), true],
  ])));

  const procs = p.topProcesses || [];
  if (procs.length) {
    const max = Math.max(...procs.map((x) => x.ramBytes || 0), 1);
    parts.push(panel('Programmes les plus gourmands', `<div class="proc-list">${procs.map((pr) => `
      <div class="proc">
        <span>${esc(pr.name)}</span><span class="v">${fmtBytes(pr.ramBytes)}</span>
        <span class="bar"><i style="width:${Math.round((pr.ramBytes / max) * 100)}%"></i></span>
      </div>`).join('')}</div>`));
  }

  return parts.join('');
}

function openDrawer(id) {
  state.selected = id;
  const m = state.machines.find((x) => x.id === id);
  if (!m) return;

  const back = document.createElement('div');
  back.className = 'drawer-backdrop';
  back.id = 'backdrop';

  const d = document.createElement('aside');
  d.className = 'drawer';
  d.id = 'drawer';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-label', `Détail du poste ${m.label || m.hostname}`);
  d.innerHTML = `
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <h2 id="d-title"></h2>
        <div class="sub" id="d-sub"></div>
        <div class="drawer-actions" style="margin-top:10px">
          <button class="btn" type="button" id="d-rename">${icon('tag')}Renommer</button>
          <button class="btn" type="button" id="d-copy">${icon('copy')}Copier le rapport</button>
          <button class="btn danger" type="button" id="d-delete">${icon('trash')}Retirer du parc</button>
        </div>
      </div>
      <button class="icon-btn" type="button" id="d-close" aria-label="Fermer">${icon('close')}</button>
    </div>
    <div class="drawer-body" id="d-body"></div>`;

  document.body.append(back, d);
  document.body.style.overflow = 'hidden';
  drawerStamp = null;
  refreshDrawer();

  back.addEventListener('click', closeDrawer);
  $('#d-close').addEventListener('click', closeDrawer);
  $('#d-rename').addEventListener('click', () => renameMachine(id));
  $('#d-copy').addEventListener('click', (e) => copyReport(id, e.currentTarget));
  $('#d-delete').addEventListener('click', () => deleteMachine(id));
  d.addEventListener('click', (e) => {
    const r = e.target.closest('[data-range]');
    if (!r) return;
    state.historyHours = Number(r.dataset.range);
    refreshDrawer({ force: true });
  });
  document.addEventListener('keydown', onEscape);
  $('#d-close').focus();
}

/** Empreinte du rapport déjà affiché dans le volet : `machine:dernierContact`. */
let drawerStamp = null;

function refreshDrawer({ force = false } = {}) {
  const d = $('#drawer');
  if (!d) return;
  const m = state.machines.find((x) => x.id === state.selected);
  if (!m) return closeDrawer();

  // L'en-tête se met à jour à chaque passage : « il y a 3 min » doit vieillir.
  $('#d-title').textContent = m.label || m.hostname;
  $('#d-sub').textContent =
    `${m.hostname} · dernier contact ${relTime(m.lastSeen)} (${fmtClock(m.lastSeen)})`;

  // Le corps, lui, ne se reconstruit que lorsqu'un nouveau rapport est arrivé.
  // Sinon le scrutage de 20 s effacerait le graphique, la position de
  // défilement et la sélection de texte, toutes les 20 secondes.
  const stamp = `${m.id}:${m.lastSeen}`;
  if (!force && stamp === drawerStamp) return;
  drawerStamp = stamp;

  const body = $('#d-body');
  const scroll = body.scrollTop;
  body.innerHTML = drawerContent(m);
  body.scrollTop = scroll;
  loadChart();
}

function cachedHistory(id, hours) {
  const entry = state.historyCache.get(`${id}:${hours}`);
  return entry && Date.now() - entry.at < 30000 ? entry.points : null;
}

async function loadChart() {
  const box = $('#chart');
  if (!box || !state.selected) return;

  // Historique déjà en cache : on trace tout de suite, sans faire clignoter
  // un « Chargement… » à chaque reconstruction du volet.
  const cached = cachedHistory(state.selected, state.historyHours);
  if (cached) return drawChart(box, cached);

  box.innerHTML = '<p class="meter-sub" style="padding:24px 0;text-align:center">Chargement…</p>';
  try {
    const points = await fetchHistory(state.selected, state.historyHours);
    const target = $('#chart');
    if (target) drawChart(target, points);
  } catch {
    const target = $('#chart');
    if (target) target.innerHTML = '<p class="meter-sub">Historique indisponible.</p>';
  }
}

function onEscape(e) {
  if (e.key === 'Escape') closeDrawer();
}

function closeDrawer() {
  state.selected = null;
  drawerStamp = null;
  $('#drawer')?.remove();
  $('#backdrop')?.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onEscape);
}

/* ============================================================ actions */

async function renameMachine(id) {
  const m = state.machines.find((x) => x.id === id);
  const label = window.prompt('Nom à afficher pour ce poste :', m?.label || m?.hostname || '');
  if (label === null) return;
  await fetch(`api/machines/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: label.trim() }),
  });
  await fetchMachines();
}

async function deleteMachine(id) {
  const m = state.machines.find((x) => x.id === id);
  const name = m?.label || m?.hostname || id;
  if (!window.confirm(
    `Retirer « ${name} » du tableau de bord ?\n\n` +
    'Son historique sera supprimé. Si son agent tourne encore, le poste réapparaîtra au prochain envoi.'
  )) return;
  await fetch(`api/machines/${encodeURIComponent(id)}`, { method: 'DELETE' });
  closeDrawer();
  await fetchMachines();
}

function buildReport(m) {
  const p = m.payload || {};
  const disk = mainDisk(m);
  const lines = [
    `POSTE ${m.label || m.hostname}  (${m.hostname})`,
    `Relevé du ${fmtClock(m.lastSeen)}`,
    '',
    `Utilisateur     ${(p.system?.loggedUser || '—')}`,
    `Modèle          ${[p.system?.manufacturer, p.system?.model].filter(Boolean).join(' ') || '—'}`,
    `Système         ${[p.system?.osName, p.system?.osDisplayVersion].filter(Boolean).join(' ') || '—'}`,
    `Allumé depuis   ${fmtDuration(p.system?.uptimeSeconds)}`,
    '',
    `Processeur      ${fmtPct(p.cpu?.loadPercent)}   ${p.cpu?.name || ''}`,
    `Mémoire         ${fmtPct(p.memory?.usedPercent)}   ${fmtBytes(p.memory?.usedBytes)} / ${fmtBytes(p.memory?.totalBytes)}`,
    `Graphique       ${fmtPct(p.gpu?.loadPercent)}   ${(p.gpu?.adapters || []).map((g) => g.name).join(', ')}`,
    ...(p.disk?.volumes || []).map((v) =>
      `Disque ${v.drive.padEnd(9)}${fmtPct(v.usedPercent)}   ${fmtBytes(v.freeBytes)} libres sur ${fmtBytes(v.totalBytes)}`),
    '',
    `IP locale       ${primaryIp(m) || '—'}`,
    `IP publique     ${p.network?.publicIp || '—'}`,
    `VPN             ${p.vpn?.connected ? `connecté (${p.vpn.name})` : 'non connecté'}`,
    `Antivirus       ${(p.security?.antivirus || []).map((a) =>
      `${a.name} ${a.realTime ? 'actif' : 'INACTIF'}`).join(' | ') || '—'}`,
    `Redémarrage     ${p.rebootPending ? 'EN ATTENTE' : 'à jour'}`,
  ];
  if (m.health.issues.length) {
    lines.push('', 'POINTS D\u2019ATTENTION');
    for (const i of m.health.issues) lines.push(`  - ${i.label} : ${i.detail}`);
  }
  return lines.join('\n');
}

async function copyReport(id, btn) {
  const m = state.machines.find((x) => x.id === id);
  if (!m) return;
  const text = buildReport(m);
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.innerHTML;
    btn.innerHTML = `${icon('ok')}Copié`;
    setTimeout(() => { btn.innerHTML = old; }, 1600);
  } catch {
    window.prompt('Copie automatique refusée par le navigateur. Sélectionne et copie :', text);
  }
}

/* ============================================================= thème */

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode || '';
  const dark = mode === 'dark'
    || (!mode && window.matchMedia('(prefers-color-scheme: dark)').matches);
  $('#theme-toggle').innerHTML = `<svg aria-hidden="true"><use href="#i-${dark ? 'moon' : 'sun'}"/></svg>`;
}

let storedTheme = '';
try { storedTheme = localStorage.getItem('komoku-theme') || ''; } catch {}
applyTheme(storedTheme);

$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme
      && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('komoku-theme', next); } catch {}
});

/* ========================================================= événements */

$('#logout').addEventListener('click', async () => {
  await fetch('api/logout', { method: 'POST' });
  window.location.replace('login.html');
});

$('#q').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});

const VIEWS = [['view-topo', 'topo'], ['view-cards', 'cards'], ['view-table', 'table']];

for (const [id, view] of VIEWS) {
  $(`#${id}`).addEventListener('click', () => {
    state.view = view;
    for (const [other, name] of VIEWS) {
      $(`#${other}`).setAttribute('aria-pressed', String(name === view));
    }
    try { localStorage.setItem('komoku-view', view); } catch {}
    render({ force: true });
  });
}

try {
  const saved = localStorage.getItem('komoku-view');
  if (VIEWS.some(([, v]) => v === saved)) {
    state.view = saved;
    for (const [id, name] of VIEWS) {
      $(`#${id}`).setAttribute('aria-pressed', String(name === saved));
    }
  }
} catch {}

$('#tiles').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tile]');
  if (!t) return;
  state.filter = state.filter === t.dataset.tile ? 'all' : t.dataset.tile;
  render();
});

$('#main').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
    return render();
  }
  const row = e.target.closest('[data-id]');
  if (row) openDrawer(row.dataset.id);
});

// La topologie et le graphique sont tracés en pixels : ils doivent être
// recalculés quand la fenêtre change de largeur.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === 'topo') drawTopology(visibleMachines());
    if (state.selected) loadChart();
  }, 150);
});

/**
 * Vieillit les « il y a 3 min » sans reconstruire le DOM : c'est ce qui permet
 * à la carte du parc de rester stable entre deux rapports.
 */
function tickRelativeTimes() {
  for (const el of document.querySelectorAll('[data-seen]')) {
    el.textContent = relTime(Number(el.dataset.seen));
  }
}

fetchMachines();
setInterval(fetchMachines, POLL_MS);
setInterval(() => {
  paintRefresh();
  tickRelativeTimes();
}, 10000);
