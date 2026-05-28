// INVPART — inventory manager. Single-page logic.
(() => {
'use strict';

// ====================== state ======================

const state = {
  me: null,
  project: null,
  ownerSet: false,
  parts: [],
  events: [],
  stats: {},
  pending: { in_transit: [], reorder: [] },
  categories: [],
  filter: { tab: 'stock', q: '', category: null, sort: 'name', evtType: null },
  openParts: new Set(),
  openEvents: new Set(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const EVENT_TYPES = ['order', 'arrival', 'use', 'adjust', 'note'];

// ====================== utilities ======================

function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtMoney(cents, { compact = false } = {}) {
  if (cents == null || isNaN(cents)) return '—';
  const dollars = cents / 100;
  if (compact && Math.abs(dollars) >= 1000) {
    return '$' + (dollars / 1000).toFixed(1) + 'k';
  }
  return '$' + dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQty(n, unit) {
  if (n == null) return '—';
  const v = Number.isInteger(n) ? n : Number(n).toFixed(2).replace(/\.?0+$/, '');
  return `${v}${unit && unit !== 'each' ? ` <span class="u">${escapeHtml(unit)}</span>` : ` <span class="u">${escapeHtml(unit || 'each')}</span>`}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDay(iso) {
  const d = new Date(iso);
  const now = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - dayStart) / 86400000);
  if (diffDays === 0) return { lbl: 'Today', ago: 'now' };
  if (diffDays === 1) return { lbl: 'Yesterday', ago: '1d ago' };
  const lbl = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const yr = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  return { lbl: lbl + yr, ago: diffDays < 7 ? `${diffDays}d ago` :
    diffDays < 31 ? `${Math.floor(diffDays/7)}w ago` :
    diffDays < 365 ? `${Math.floor(diffDays/30)}mo ago` : `${Math.floor(diffDays/365)}y ago` };
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function thumbInitials(name) {
  const parts = name.replace(/[^A-Za-z0-9 -]/g, ' ').trim().split(/\s+/).slice(0, 2);
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ====================== api ======================

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) { state.me = null; throw new Error('unauthorized'); }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`${r.status} ${t}`);
  }
  return (r.headers.get('content-type') || '').includes('json') ? r.json() : r.text();
}

async function apiForm(path, fd, method = 'POST') {
  const r = await fetch(path, { method, body: fd, credentials: 'same-origin' });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`${r.status} ${t}`);
  }
  return r.json();
}

// ====================== boot ======================

async function boot() {
  startClock();
  bindTabs();
  bindGlobal();
  bindTheme();
  bindAddForm();
  bindActDialog();
  bindInvite();
  bindBootstrap();

  const me = await api('/api/me');
  state.me = me.member; state.project = me.project; state.ownerSet = me.owner_set;

  if (!state.ownerSet) { $('#bootstrapDialog').hidden = false; return; }
  if (!state.me) {
    document.body.innerHTML = `
      <header class="topbar"><div class="wrap top-grid">
        <a href="/" class="brand"><span class="glyph"></span>INVPART</a>
        <div></div><div></div>
      </div></header>
      <section class="hero"><div class="wrap">
        <div class="cap">Access</div>
        <h1 class="tight" style="margin-top:1rem">
          You need an invite to <span class="dim">${escapeHtml(state.project?.name || 'this inventory')}.</span>
        </h1>
        <p class="dim" style="margin-top:1rem">Ask the owner for a link.</p>
      </div></section>`;
    return;
  }

  await refreshAll();
  renderAll();
}

async function refreshAll() {
  const [parts, events, stats, members, pending] = await Promise.all([
    api('/api/parts?' + partsQuery()),
    api('/api/events?limit=200'),
    api('/api/stats'),
    api('/api/members'),
    api('/api/pending'),
  ]);
  state.parts = parts.parts;
  state.events = events.events;
  state.stats = stats;
  state.members = members.members;
  state.pending = pending;
  state.categories = stats.categories || [];
}

function partsQuery() {
  const p = new URLSearchParams();
  if (state.filter.q) p.set('q', state.filter.q);
  if (state.filter.category) p.set('category', state.filter.category);
  if (state.filter.sort) p.set('sort', state.filter.sort);
  return p.toString();
}

async function refreshParts() {
  const r = await api('/api/parts?' + partsQuery());
  state.parts = r.parts;
  renderParts();
}

async function refreshEvents() {
  const p = new URLSearchParams();
  if (state.filter.evtType) p.set('type', state.filter.evtType);
  const r = await api('/api/events?' + p.toString());
  state.events = r.events;
  renderActivity();
}

async function refreshPending() {
  state.pending = await api('/api/pending');
  renderPending();
}

async function refreshStats() {
  state.stats = await api('/api/stats');
  state.categories = state.stats.categories || [];
  renderHeroStats();
  renderTabCounts();
  renderSpend();
  renderCategoryFilter();
}

// ====================== render ======================

function renderAll() {
  renderTopbar();
  renderHeroStats();
  renderTabCounts();
  renderCategoryFilter();
  renderEventFilters();
  renderParts();
  renderActivity();
  renderPending();
  renderSpend();
  renderFooter();
}

function renderTopbar() {
  $('#projectName').textContent = state.project?.name || '—';
  const inline = $('#membersInline');
  inline.innerHTML = (state.members || []).slice(0, 5).map(m =>
    `<span class="dot" style="background:${escapeHtml(m.color)}" title="${escapeHtml(m.name)}">${escapeHtml(initials(m.name))}</span>`
  ).join('');
  $('#inviteBtn').hidden = !state.me?.is_owner;
}

function renderHeroStats() {
  const s = state.stats;
  const items = [
    { num: fmtMoney(s.stock_value_cents || 0, { compact: true }), lbl: 'stock value', sub: `${s.parts || 0} parts` },
    { num: fmtMoney(s.spent_cents || 0, { compact: true }), lbl: 'total spent' },
    { num: fmtMoney(s.in_transit_cents || 0, { compact: true }), lbl: 'in transit', sub: `${state.pending.in_transit.length || 0} orders` },
    { num: state.pending.reorder.length || 0, lbl: 'below reorder', sub: state.pending.reorder.length ? 'attention' : 'all stocked' },
  ];
  $('#bigStats').innerHTML = items.map(it => `
    <div class="bigstat">
      <div class="num">${it.num}</div>
      <div class="lbl">${escapeHtml(it.lbl)}</div>
      <div class="sub">${escapeHtml(it.sub || '')}</div>
    </div>
  `).join('');
}

function renderTabCounts() {
  $('#tabnStock').textContent = state.stats.parts ?? '';
  $('#tabnActivity').textContent = state.events.length ?? '';
  const p = (state.pending.in_transit?.length || 0) + (state.pending.reorder?.length || 0);
  $('#tabnPending').textContent = p ? p : '';
  $('#tabnSpend').textContent = state.stats.spent_cents ? fmtMoney(state.stats.spent_cents, { compact: true }) : '';
}

function renderCategoryFilter() {
  const box = $('#catFilters');
  if (!state.categories.length) { box.innerHTML = ''; return; }
  box.innerHTML = state.categories.slice(0, 12).map(c => `
    <button class="c ${state.filter.category === c ? 'on' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>
  `).join('');
  $$('button.c', box).forEach(b => {
    b.addEventListener('click', () => {
      const c = b.dataset.cat;
      state.filter.category = state.filter.category === c ? null : c;
      renderCategoryFilter(); renderPartsActive();
      refreshParts();
    });
  });
}

function renderPartsActive() {
  const f = state.filter;
  const bits = [];
  if (f.category) bits.push(`cat: ${f.category}`);
  if (f.q) bits.push(`"${f.q}"`);
  const box = $('#partsActive');
  if (!bits.length) { box.innerHTML = ''; return; }
  box.innerHTML = `${escapeHtml(bits.join(' · '))} <span class="clear" id="clearPartsFilter">clear</span>`;
  $('#clearPartsFilter').addEventListener('click', () => {
    state.filter.q = ''; state.filter.category = null;
    $('#searchInput').value = '';
    renderCategoryFilter(); renderPartsActive();
    refreshParts();
  });
}

function renderParts() {
  const list = $('#partsList');
  $('#partsCount').textContent = `${state.parts.length} part${state.parts.length === 1 ? '' : 's'}`;
  renderPartsActive();
  const empty = $('#partsEmpty');
  if (!state.parts.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = state.parts.map(renderPartRow).join('');
  // Bind expand
  $$('.part', list).forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('a, button, .row-btn, .t, .part-link')) return;
      const id = el.dataset.id;
      if (state.openParts.has(id)) state.openParts.delete(id);
      else state.openParts.add(id);
      el.classList.toggle('open');
      renderPartBody(el);
    });
  });
  // Pre-expand
  $$('.part', list).forEach(el => {
    if (state.openParts.has(el.dataset.id)) {
      el.classList.add('open');
      renderPartBody(el);
    }
  });
}

function renderPartRow(p) {
  const low = p.target_min > 0 && p.on_hand < p.target_min;
  const totalVal = p.unit_cost_cents != null ? p.unit_cost_cents * p.on_hand : null;
  const imgUrl = p.image ? '/' + p.image.replace(/^\/+/, '') : null;
  const thumb = imgUrl
    ? `<img src="${escapeHtml(imgUrl)}" alt="">`
    : `${escapeHtml(thumbInitials(p.name))}`;
  return `
    <div class="part" data-id="${escapeHtml(p.id)}">
      <div class="part-head">
        <div class="part-thumb">${thumb}</div>
        <div class="part-name tight">
          ${escapeHtml(p.name)}
          ${p.supplier ? `<span class="sup">${escapeHtml(p.supplier)}${p.link ? ' ·' : ''}</span>` : ''}
        </div>
        <div class="part-cat">${escapeHtml(p.category || '')}</div>
        <div class="part-qty ${low ? 'low' : ''}">${fmtQty(p.on_hand, p.unit)}
          ${p.on_order > 0 ? `<span class="on-order">+${fmtQty(p.on_order, p.unit).replace(/<[^>]+>/g, '').trim()} on order</span>` : ''}
        </div>
        <div class="part-cost">
          ${p.unit_cost_cents != null ? fmtMoney(p.unit_cost_cents) : '—'}
          ${totalVal != null && p.on_hand > 0 ? `<span class="total">${fmtMoney(totalVal, { compact: true })} on hand</span>` : ''}
        </div>
        <div class="part-arrow">→</div>
      </div>
      <div class="part-body" data-loaded="0"></div>
    </div>
  `;
}

function renderPartBody(el) {
  const body = $('.part-body', el);
  if (body.dataset.loaded === '1') return;
  const p = state.parts.find(x => x.id === el.dataset.id);
  if (!p) return;
  body.dataset.loaded = '1';
  const assets = (p.assets || []).map(a => {
    const isImg = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(a.path);
    const url = '/' + a.path.replace(/^\/+/, '');
    if (isImg) return `<a href="${escapeHtml(url)}" target="_blank"><img loading="lazy" src="${escapeHtml(url)}" alt=""></a>`;
    return `<a href="${escapeHtml(url)}" target="_blank" class="file">
      <span class="ext">${escapeHtml(fileExt(a.name) || 'file')}</span>
      <span class="fname">${escapeHtml(a.name)}</span>
      <span class="fsize">${escapeHtml(fmtBytes(a.size))}</span>
    </a>`;
  }).join('');

  body.innerHTML = `
    <div class="part-body-inner">
      <div>
        <div class="part-section-cap">Notes</div>
        <div class="part-notes">${escapeHtml(p.notes || '—')}</div>
        ${p.link ? `<a class="part-link" href="${escapeHtml(p.link)}" target="_blank">↗ supplier page</a>` : ''}
        ${(p.tags || []).length ? `<div class="part-tags">${p.tags.map(t => `<span class="t" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        ${assets ? `<div class="part-section-cap" style="margin-top:1.5rem">Files</div><div class="part-assets">${assets}</div>` : ''}
        <div class="part-meta">
          <span>reorder at ${p.target_min || 0}</span>
          <span>updated ${new Date(p.updated_at).toLocaleString()}</span>
          <span>id ${p.id.slice(0,6)}</span>
        </div>
      </div>
      <div class="part-side">
        <div>
          <div class="part-section-cap">Quick actions</div>
          <div class="part-actions">
            <a class="row-btn" data-act="order" data-id="${escapeHtml(p.id)}">Order more <span class="ar">+</span></a>
            <a class="row-btn" data-act="use" data-id="${escapeHtml(p.id)}">Mark used <span class="ar">−</span></a>
            <a class="row-btn" data-act="adjust" data-id="${escapeHtml(p.id)}">Adjust stock <span class="ar">±</span></a>
            <a class="row-btn" data-act="edit" data-id="${escapeHtml(p.id)}">Edit part <span class="ar">→</span></a>
            <a class="row-btn danger" data-act="delete" data-id="${escapeHtml(p.id)}">Delete <span class="ar">×</span></a>
          </div>
        </div>
      </div>
    </div>
  `;
  $$('.row-btn', body).forEach(b => b.addEventListener('click', onPartAction));
  $$('.part-tags .t', body).forEach(b => b.addEventListener('click', () => {
    state.filter.q = '#' + b.dataset.tag;
    $('#searchInput').value = state.filter.q;
    renderPartsActive(); refreshParts();
  }));
}

function renderActivity() {
  const list = $('#activityList');
  const empty = $('#activityEmpty');
  if (!state.events.length) {
    list.innerHTML = ''; empty.hidden = false; return;
  }
  empty.hidden = true;
  // Group by day
  const groups = new Map();
  for (const e of state.events) {
    const d = e.created_at.slice(0, 10);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(e);
  }
  const out = [];
  for (const [day, evts] of groups) {
    const { lbl, ago } = fmtDay(day + 'T00:00:00Z');
    out.push(`
      <div class="day">
        <div class="day-lbl">${escapeHtml(lbl)}<span class="ago">${escapeHtml(ago)}</span></div>
        <div class="day-list">${evts.map(renderEventRow).join('')}</div>
      </div>
    `);
  }
  list.innerHTML = out.join('');

  $$('.event', list).forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('a, button, .act')) return;
      const id = el.dataset.id;
      if (state.openEvents.has(id)) state.openEvents.delete(id);
      else state.openEvents.add(id);
      el.classList.toggle('open');
      renderEventBody(el);
    });
  });
  $$('.event', list).forEach(el => {
    if (state.openEvents.has(el.dataset.id)) {
      el.classList.add('open');
      renderEventBody(el);
    }
  });
}

function renderEventRow(e) {
  const verb = {
    order: 'Ordered', arrival: 'Received', use: 'Used',
    adjust: 'Adjusted', note: 'Noted',
  }[e.type] || e.type;
  const totalQty = (e.lines || []).reduce((a, b) => a + Math.abs(b.qty || 0), 0);
  const partsSummary = (e.lines || []).slice(0, 2)
    .map(l => `${Math.abs(l.qty)}× ${l.part_name || l.part_id.slice(0,6)}`)
    .join(', ') + ((e.lines || []).length > 2 ? ` +${e.lines.length - 2} more` : '');
  const summary = partsSummary || (e.body ? e.body.slice(0, 60) : '—');
  return `
    <div class="event" data-id="${escapeHtml(e.id)}">
      <div class="event-head">
        <span class="event-time mono">${escapeHtml(fmtTime(e.created_at))}</span>
        <span class="event-type t-${escapeHtml(e.type)}">
          ${escapeHtml(verb)}
          ${e.status ? `<span class="status">${escapeHtml(e.status)}</span>` : ''}
        </span>
        <span class="event-summary tight">
          <span class="auth" style="background:${escapeHtml(e.author.color)}" title="${escapeHtml(e.author.name)}">${escapeHtml(initials(e.author.name))}</span>
          ${escapeHtml(summary)}
        </span>
        <span class="event-cost">${e.cost_cents != null ? fmtMoney(e.cost_cents) : ''}</span>
        <span class="event-arrow">→</span>
      </div>
      <div class="event-body" data-loaded="0"></div>
    </div>
  `;
}

function renderEventBody(el) {
  const body = $('.event-body', el);
  if (body.dataset.loaded === '1') return;
  const e = state.events.find(x => x.id === el.dataset.id);
  if (!e) return;
  body.dataset.loaded = '1';
  const lines = (e.lines || []).map(l => `
    <div class="ln">
      <span>${escapeHtml(l.part_name || '(deleted part)')}</span>
      <span class="qty">${l.qty > 0 ? '+' : ''}${l.qty} ${escapeHtml(l.unit || 'each')}</span>
      <span class="cost">${l.unit_cost_cents != null ? `${fmtMoney(l.unit_cost_cents)} ea · ${fmtMoney(l.unit_cost_cents * Math.abs(l.qty))}` : ''}</span>
    </div>`).join('');
  const canEdit = state.me && (state.me.id === e.author_id || state.me.is_owner);
  const canReceive = e.type === 'order' && (e.status === 'placed' || e.status === 'in_transit');
  body.innerHTML = `
    <div class="event-body-inner">
      ${lines ? `<div class="event-lines">${lines}</div>` : ''}
      ${e.body ? `<div class="event-note">${escapeHtml(e.body)}</div>` : ''}
      <div class="event-meta">
        ${e.supplier ? `<span>supplier ${escapeHtml(e.supplier)}</span>` : ''}
        ${e.expected_arrival ? `<span>eta ${escapeHtml(e.expected_arrival)}</span>` : ''}
        ${e.tracking_url ? `<span>track <a href="${escapeHtml(e.tracking_url)}" target="_blank">link</a></span>` : ''}
        <span>by ${escapeHtml(e.author.name)}</span>
        <span>${escapeHtml(new Date(e.created_at).toLocaleString())}</span>
        <span class="event-actions">
          ${canReceive ? `<span class="act receive" data-act="receive" data-id="${escapeHtml(e.id)}">mark received</span>` : ''}
          ${canEdit ? `<span class="act danger" data-act="del" data-id="${escapeHtml(e.id)}">delete</span>` : ''}
        </span>
      </div>
    </div>
  `;
  $$('.act', body).forEach(b => b.addEventListener('click', onEventAction));
}

function renderPending() {
  const inT = $('#inTransit');
  const inTE = $('#inTransitEmpty');
  const re = $('#reorderList');
  const reE = $('#reorderEmpty');
  const orders = state.pending.in_transit || [];
  const reorder = state.pending.reorder || [];

  if (!orders.length) { inT.innerHTML = ''; inTE.hidden = false; }
  else {
    inTE.hidden = true;
    inT.innerHTML = orders.map(e => {
      const items = (e.lines || []).map(l => `<span class="qty">${l.qty}×</span>${escapeHtml(l.part_name || '?')}`).join(' · ');
      return `
        <div class="transit-card">
          <div class="info">
            <div class="sup tight">${escapeHtml(e.supplier || 'Order')}</div>
            <div class="eta">placed ${escapeHtml(new Date(e.created_at).toLocaleDateString())} ${e.expected_arrival ? `· eta ${escapeHtml(e.expected_arrival)}` : ''}</div>
            <div class="items">${items || '—'}</div>
            ${e.tracking_url ? `<a class="link" href="${escapeHtml(e.tracking_url)}" target="_blank" style="margin-top:.35rem; align-self:flex-start">track →</a>` : ''}
          </div>
          <div class="right">
            <div class="cost">${e.cost_cents != null ? fmtMoney(e.cost_cents) : ''}</div>
            <button class="pill sm" data-act="receive" data-id="${escapeHtml(e.id)}">mark received</button>
          </div>
        </div>`;
    }).join('');
    $$('#inTransit [data-act="receive"]').forEach(b => b.addEventListener('click', onEventAction));
  }

  if (!reorder.length) { re.innerHTML = ''; reE.hidden = false; }
  else {
    reE.hidden = true;
    re.innerHTML = reorder.map(p => `
      <div class="reorder-row">
        <div class="nm tight">${escapeHtml(p.name)}
          ${p.supplier ? `<span class="sup">${escapeHtml(p.supplier)}</span>` : ''}
        </div>
        <div class="qty">${p.on_hand} <span class="tgt">/ ${p.target_min}</span></div>
        <button class="pill sm ghost" data-act="order" data-id="${escapeHtml(p.id)}">order +</button>
      </div>
    `).join('');
    $$('#reorderList [data-act="order"]').forEach(b => b.addEventListener('click', (e) => {
      openActDialog(e.currentTarget.dataset.id, 'order');
    }));
  }
}

function renderSpend() {
  const s = state.stats;
  $('#spendStats').innerHTML = [
    { num: fmtMoney(s.spent_cents || 0), lbl: 'total spent' },
    { num: fmtMoney(s.stock_value_cents || 0), lbl: 'stock value' },
    { num: fmtMoney(s.in_transit_cents || 0), lbl: 'in transit' },
    { num: fmtMoney(((s.by_month || [])[0]?.spent_cents) || 0), lbl: 'this month' },
  ].map(it => `<div class="bigstat"><div class="num">${it.num}</div><div class="lbl">${escapeHtml(it.lbl)}</div></div>`).join('');

  const months = (s.by_month || []).slice().reverse();
  const maxM = Math.max(1, ...months.map(m => m.spent_cents));
  $('#byMonth').innerHTML = months.length ? months.reverse().map(m => `
    <div class="bar-row">
      <div class="l mono">${escapeHtml(m.month)}</div>
      <div class="b" style="--w:${(m.spent_cents / maxM * 100).toFixed(1)}%"></div>
      <div class="v">${fmtMoney(m.spent_cents)}</div>
    </div>
  `).join('') : '<div class="dim mono cap" style="padding:1.2rem 0">no spend yet</div>';

  const cats = s.by_category || [];
  const maxC = Math.max(1, ...cats.map(c => c.spent_cents));
  $('#byCategory').innerHTML = cats.length ? cats.map(c => `
    <div class="bar-row">
      <div class="l">${escapeHtml(c.category)}</div>
      <div class="b" style="--w:${(c.spent_cents / maxC * 100).toFixed(1)}%"></div>
      <div class="v">${fmtMoney(c.spent_cents)}</div>
    </div>
  `).join('') : '<div class="dim mono cap" style="padding:1.2rem 0">no categorized spend yet</div>';
}

function renderEventFilters() {
  const box = $('#actFilters');
  const totals = state.events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
  const items = [{ key: null, label: 'all', n: state.events.length },
    ...EVENT_TYPES.map(k => ({ key: k, label: k, n: totals[k] || 0 }))];
  box.innerHTML = `<div class="filt-cat">${items.map(it => `
    <button class="c ${state.filter.evtType === it.key ? 'on' : ''}" data-evt="${it.key ?? ''}">${escapeHtml(it.label)} <span class="dim">${it.n}</span></button>
  `).join('')}</div>`;
  $$('#actFilters .c').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.evt || null;
    state.filter.evtType = state.filter.evtType === k ? null : k;
    renderEventFilters();
    refreshEvents();
  }));
}

function renderFooter() {
  $('#footVault').textContent = state.stats.host ? `host: ${state.stats.host}` : '';
}

// ====================== tabs ======================

function bindTabs() {
  $$('.tab').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
}

function switchTab(tab) {
  state.filter.tab = tab;
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === tab));
}

// ====================== add part form ======================

function bindAddForm() {
  $('#openAdd').addEventListener('click', () => {
    const f = $('#addForm');
    f.hidden = !f.hidden;
    if (!f.hidden) f.querySelector('input[name="name"]').focus();
  });
  $('#cancelAdd').addEventListener('click', () => { $('#addForm').hidden = true; $('#addForm').reset(); });
  $('#addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const fd = new FormData();
    for (const name of ['name','category','supplier','link','unit','on_hand','target_min','tags','notes']) {
      const v = f.elements[name]?.value || '';
      if (v) fd.set(name, v);
    }
    const cost = f.elements.unit_cost.value;
    if (cost) fd.set('unit_cost_cents', String(Math.round(parseFloat(cost) * 100)));
    const filesEl = f.elements.files;
    for (const file of filesEl.files || []) fd.append('files', file);
    try {
      await apiForm('/api/parts', fd);
      f.reset(); f.hidden = true;
      await refreshAll(); renderAll();
      toast('part added');
    } catch (err) { toast('failed: ' + err.message, 'err'); }
  });
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout($('#searchInput')._h);
    $('#searchInput')._h = setTimeout(() => {
      state.filter.q = e.target.value.trim();
      renderPartsActive(); refreshParts();
    }, 200);
  });
  $('#sortSelect').addEventListener('change', (e) => {
    state.filter.sort = e.target.value;
    refreshParts();
  });
}

// ====================== part actions (order/use/adjust/edit/delete) ======================

async function onPartAction(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const b = ev.currentTarget;
  const id = b.dataset.id; const act = b.dataset.act;
  const p = state.parts.find(x => x.id === id);
  if (!p) return;

  if (act === 'delete') {
    if (!confirm(`Delete "${p.name}"? Its markdown file will be removed.`)) return;
    try {
      await api(`/api/parts/${id}`, { method: 'DELETE' });
      state.openParts.delete(id);
      await refreshAll(); renderAll();
      toast('deleted');
    } catch (err) { toast('failed: ' + err.message, 'err'); }
    return;
  }

  if (act === 'edit') {
    openEditPart(p);
    return;
  }

  openActDialog(id, act);
}

function openActDialog(partId, action) {
  const p = state.parts.find(x => x.id === partId);
  if (!p) return;
  const dlg = $('#actDialog');
  const form = $('#actForm');
  form.reset();
  form.elements.part_id.value = partId;
  form.elements.action.value = action;
  const labels = {
    order: { kind: 'Order more', title: `+ Order ${p.name}` },
    use:   { kind: 'Mark used',  title: `− Used ${p.name}` },
    adjust:{ kind: 'Adjust',     title: `± Adjust ${p.name}` },
  };
  $('#actDialogKind').textContent = labels[action].kind;
  $('#actDialogTitle').textContent = labels[action].title;
  // Show/hide fields based on action
  const showCost = action === 'order' || action === 'adjust';
  const showSupplier = action === 'order';
  const showTracking = action === 'order';
  const showEta = action === 'order';
  $('#costField').style.display = showCost ? '' : 'none';
  $('#supplierField').style.display = showSupplier ? '' : 'none';
  $('#trackingField').style.display = showTracking ? '' : 'none';
  $('#etaField').style.display = showEta ? '' : 'none';
  // Prefill
  if (p.unit_cost_cents != null) form.elements.unit_cost.value = (p.unit_cost_cents / 100).toFixed(2);
  if (p.supplier) form.elements.supplier.value = p.supplier;
  $('#actSubmit').textContent = { order:'place order →', use:'log usage →', adjust:'apply →' }[action];
  dlg.hidden = false;
  setTimeout(() => form.elements.qty.focus(), 30);
}

function bindActDialog() {
  $('#actCancel').addEventListener('click', () => $('#actDialog').hidden = true);
  $('#actDialog').addEventListener('click', (e) => {
    if (e.target === $('#actDialog')) $('#actDialog').hidden = true;
  });
  $('#actForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const partId = f.elements.part_id.value;
    const action = f.elements.action.value;
    const qty = parseFloat(f.elements.qty.value) || 0;
    if (qty <= 0 && action !== 'adjust') { toast('quantity must be > 0', 'err'); return; }
    const cost = f.elements.unit_cost.value;
    const unitCostCents = cost ? Math.round(parseFloat(cost) * 100) : null;
    const fd = new FormData();
    const lineQty = action === 'use' ? qty : qty;  // backend sign-aware by event type
    fd.set('type', action === 'order' ? 'order' : action === 'use' ? 'use' : 'adjust');
    fd.set('lines', JSON.stringify([{
      part_id: partId, qty: action === 'adjust' ? (parseFloat(f.elements.qty.value) || 0) : lineQty,
      unit_cost_cents: unitCostCents,
    }]));
    if (action === 'order') {
      fd.set('status', 'placed');
      if (f.elements.supplier.value) fd.set('supplier', f.elements.supplier.value);
      if (f.elements.tracking_url.value) fd.set('tracking_url', f.elements.tracking_url.value);
      if (f.elements.expected_arrival.value) fd.set('expected_arrival', f.elements.expected_arrival.value);
    }
    if (f.elements.body.value) fd.set('body', f.elements.body.value);
    for (const file of f.elements.files.files || []) fd.append('files', file);
    try {
      await apiForm('/api/events', fd);
      $('#actDialog').hidden = true;
      await refreshAll(); renderAll();
      toast({ order:'order logged', use:'usage logged', adjust:'stock adjusted' }[action]);
    } catch (err) { toast('failed: ' + err.message, 'err'); }
  });
}

function openEditPart(p) {
  // Quick inline edit via prompts (V1 — improve later)
  const fields = [
    { k: 'name', label: 'Name' },
    { k: 'category', label: 'Category' },
    { k: 'supplier', label: 'Supplier' },
    { k: 'link', label: 'Product link' },
    { k: 'unit_cost', label: 'Unit cost ($)', cur: p.unit_cost_cents != null ? (p.unit_cost_cents/100).toFixed(2) : '' },
    { k: 'target_min', label: 'Reorder threshold' },
    { k: 'notes', label: 'Notes (markdown)' },
  ];
  const out = {};
  for (const fd of fields) {
    const cur = fd.cur ?? p[fd.k] ?? '';
    const v = prompt(fd.label + ':', cur);
    if (v === null) return;  // user cancelled
    out[fd.k] = v;
  }
  const body = {};
  for (const [k, v] of Object.entries(out)) {
    if (k === 'unit_cost') body.unit_cost_cents = v ? Math.round(parseFloat(v) * 100) : null;
    else if (k === 'target_min') body.target_min = parseFloat(v) || 0;
    else body[k] = v;
  }
  api(`/api/parts/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async () => {
    await refreshAll(); renderAll(); toast('saved');
  }).catch(err => toast('failed: ' + err.message, 'err'));
}

// ====================== event actions ======================

async function onEventAction(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const b = ev.currentTarget;
  const id = b.dataset.id; const act = b.dataset.act;
  if (act === 'del') {
    if (!confirm('Delete this event? Its quantity effect on parts will be reversed.')) return;
    try {
      await api(`/api/events/${id}`, { method: 'DELETE' });
      state.openEvents.delete(id);
      await refreshAll(); renderAll();
      toast('deleted');
    } catch (err) { toast('failed: ' + err.message, 'err'); }
  } else if (act === 'receive') {
    try {
      await api(`/api/events/${id}/receive`, { method: 'POST' });
      await refreshAll(); renderAll();
      toast('received — stock updated');
    } catch (err) { toast('failed: ' + err.message, 'err'); }
  }
}

// ====================== invite dialog ======================

function bindInvite() {
  $('#inviteBtn').addEventListener('click', async () => {
    try {
      const r = await api('/api/invite', { method: 'POST' });
      $('#inviteUrl').value = r.url;
      $('#inviteDialog').hidden = false;
    } catch (err) { toast('failed: ' + err.message, 'err'); }
  });
  $('#inviteClose').addEventListener('click', () => $('#inviteDialog').hidden = true);
  $('#inviteCopy').addEventListener('click', async () => {
    const url = $('#inviteUrl').value;
    try { await navigator.clipboard.writeText(url); toast('copied'); }
    catch { $('#inviteUrl').select(); document.execCommand('copy'); toast('copied'); }
  });
  $('#inviteDialog').addEventListener('click', (e) => {
    if (e.target === $('#inviteDialog')) $('#inviteDialog').hidden = true;
  });
}

// ====================== bootstrap dialog ======================

function bindBootstrap() {
  $('#bootstrapForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const submitBtn = f.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    const project = f.project.value.trim();
    const name = f.name.value.trim();
    try {
      await api('/api/bootstrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, name }),
      });
      $('#bootstrapDialog').hidden = true;
      location.reload();
    } catch (err) {
      if (/^409\b/.test(err.message)) {
        toast('this inventory is already set up — reloading', 'err');
        setTimeout(() => location.reload(), 600);
        return;
      }
      toast('start failed: ' + err.message, 'err');
      submitBtn.disabled = false;
    }
  });
}

// ====================== theme + clock + globals ======================

function bindTheme() {
  const saved = localStorage.getItem('invpart_theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('invpart_theme', next);
  });
}

function startClock() {
  const tick = () => {
    const d = new Date();
    const p = n => n < 10 ? '0' + n : '' + n;
    $('#localTime').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

function bindGlobal() {
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      $$('.dialog:not([hidden])').forEach(d => d.hidden = true);
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k') {
      ev.preventDefault();
      switchTab('stock');
      $('#searchInput').focus();
    }
    if (ev.key === 'a' && !/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) {
      switchTab('stock');
      $('#openAdd').click();
    }
    // Number keys 1-4 switch tabs
    if (['1','2','3','4'].includes(ev.key) && !/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) {
      switchTab(['stock','activity','pending','spend'][parseInt(ev.key, 10) - 1]);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch(err => {
    console.error(err);
    toast('boot failed: ' + err.message, 'err');
  });
});

})();
