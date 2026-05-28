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
  invoices: [],
  stats: {},
  pending: { in_transit: [], reorder: [] },
  categories: [],
  tagNames: [],
  vendors: [],
  filter: { tab: 'stock', q: '', category: null, sort: 'name', evtType: null,
            invQ: '', invVendor: null, invSort: 'date_desc' },
  openParts: new Set(),
  openEvents: new Set(),
  openInvoices: new Set(),
  partInvoicesCache: new Map(),  // part_id → invoices (loaded on expand)
  partDialog: { mode: 'add', editingId: null, pickedTags: new Set(), pickedCat: null, existingAssets: [], removedAssets: new Set() },
  invoiceDialog: { mode: 'add', editingId: null, pickedParts: new Set(), existingAssets: [], pickerFilter: '' },
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
  const rupees = cents / 100;
  if (compact) {
    const abs = Math.abs(rupees);
    if (abs >= 10000000) return '₹' + (rupees / 10000000).toFixed(2) + 'Cr';
    if (abs >= 100000)   return '₹' + (rupees / 100000).toFixed(2)   + 'L';
    if (abs >= 1000)     return '₹' + (rupees / 1000).toFixed(1)     + 'k';
  }
  return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  bindPartDialog();
  bindInvoiceDialog();
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
  const [parts, events, stats, members, pending, tags, invoices] = await Promise.all([
    api('/api/parts?' + partsQuery()),
    api('/api/events?limit=200'),
    api('/api/stats'),
    api('/api/members'),
    api('/api/pending'),
    api('/api/tags'),
    api('/api/invoices?' + invoicesQuery()),
  ]);
  state.parts = parts.parts;
  state.events = events.events;
  state.stats = stats;
  state.members = members.members;
  state.pending = pending;
  state.categories = stats.categories || [];
  state.tagNames = tags.tag_names || [];
  state.vendors = tags.vendors || [];
  state.invoices = invoices.invoices;
  state.partInvoicesCache.clear();
}

function invoicesQuery() {
  const p = new URLSearchParams();
  if (state.filter.invVendor) p.set('vendor', state.filter.invVendor);
  if (state.filter.invSort) p.set('sort', state.filter.invSort);
  return p.toString();
}

async function refreshInvoices() {
  const r = await api('/api/invoices?' + invoicesQuery());
  state.invoices = r.invoices;
  state.partInvoicesCache.clear();
  renderInvoices();
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
  renderInvoices();
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
  const spent    = s.total_spent_cents      || 0;
  const planned  = s.planned_expenses_cents || 0;
  const budget   = s.budget_cents           || 0;
  const remain   = s.remaining_balance_cents != null
    ? s.remaining_balance_cents : (budget - spent);

  const items = [
    { num: fmtMoney(spent,   { compact: true }), lbl: 'total spent',
      sub: 'in house · in transit · placed' },
    { num: fmtMoney(planned, { compact: true }), lbl: 'planned expenses',
      sub: 'yet to be placed · not in total' },
    { num: fmtMoney(remain,  { compact: true }), lbl: 'remaining balance',
      sub: `of ${fmtMoney(budget, { compact: true })}` },
    { num: fmtMoney(budget,  { compact: true }), lbl: 'budget',
      sub: (() => {
        const n = (state.parts || []).filter(p => p.status === 'to_order').length;
        return n ? `${n} parts to order` : 'no pending orders';
      })() },
  ];
  $('#bigStats').innerHTML = items.map(it => `
    <div class="bigstat">
      <div class="num ${it.lbl === 'remaining balance' && remain < 0 ? 'neg' : ''}">${it.num}</div>
      <div class="lbl">${escapeHtml(it.lbl)}</div>
      <div class="sub">${escapeHtml(it.sub || '')}</div>
    </div>
  `).join('');
}

function renderTabCounts() {
  $('#tabnStock').textContent = state.stats.parts ?? '';
  $('#tabnActivity').textContent = state.events.length ?? '';
  // Pending count = parts flagged "Yet to place" (status=to_order)
  const toOrderCount = (state.parts || []).filter(p => p.status === 'to_order').length;
  $('#tabnPending').textContent = toOrderCount ? toOrderCount : '';
  $('#tabnInvoices').textContent = state.stats.invoices ?? state.invoices.length ?? '';
  $('#tabnSpend').textContent = state.stats.total_spent_cents
    ? fmtMoney(state.stats.total_spent_cents, { compact: true }) : '';
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

const STATUS_LABEL = {
  to_order:   'Yet to place',
  ordered:    'Order placed',
  in_transit: 'In transit',
  in_house:   'In house',         // synthetic — derived from on_hand>0 + status null
};

function renderPartRow(p) {
  const low = p.target_min > 0 && p.on_hand < p.target_min;
  const totalVal = p.unit_cost_cents != null ? p.unit_cost_cents * p.on_hand : null;
  const imgUrl = p.image ? '/' + p.image.replace(/^\/+/, '') : null;
  const thumb = imgUrl
    ? `<img src="${escapeHtml(imgUrl)}" alt="">`
    : `${escapeHtml(thumbInitials(p.name))}`;
  // Pick the right badge:
  //   - explicit status takes precedence (to_order / ordered / in_transit)
  //   - else if stocked (on_hand > 0)  → "In house" (green)
  //   - else                            → no badge
  let statusBadge = '';
  if (p.status && STATUS_LABEL[p.status]) {
    statusBadge = `<span class="part-status s-${escapeHtml(p.status)}">${escapeHtml(STATUS_LABEL[p.status])}</span>`;
  } else if ((p.on_hand || 0) > 0) {
    statusBadge = `<span class="part-status s-in_house">In house</span>`;
  }
  return `
    <div class="part" data-id="${escapeHtml(p.id)}">
      <div class="part-head">
        <div class="part-thumb">${thumb}</div>
        <div class="part-name tight">
          ${escapeHtml(p.name)}${statusBadge}
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
        <div class="part-section-cap" style="margin-top:1.5rem">Invoices</div>
        <div class="part-invoices" data-part-invoices="${escapeHtml(p.id)}">
          <div class="dim mono cap" style="padding:.6rem 0">loading…</div>
        </div>
        <div class="part-meta">
          <span>planned ${p.target_min || 0}</span>
          ${p.date ? `<span>date ${escapeHtml(p.date)}</span>` : ''}
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
  loadPartInvoices(p.id, body);
}

async function loadPartInvoices(partId, body) {
  const slot = body.querySelector(`[data-part-invoices="${CSS.escape(partId)}"]`);
  if (!slot) return;
  // Cache to avoid re-fetching on every collapse/expand
  let list = state.partInvoicesCache.get(partId);
  if (!list) {
    try {
      // Use the already-fetched state.invoices and filter — cheaper than another HTTP call
      list = state.invoices.filter(inv =>
        (inv.parts || []).some(p => p.id === partId)
      );
      state.partInvoicesCache.set(partId, list);
    } catch (err) {
      slot.innerHTML = `<div class="dim mono cap" style="padding:.6rem 0">load failed</div>`;
      return;
    }
  }
  if (!list.length) {
    slot.innerHTML = `<div class="dim mono cap" style="padding:.6rem 0">no invoices linked yet</div>`;
    return;
  }
  slot.innerHTML = list.map(inv => `
    <div class="pi" data-invoice-id="${escapeHtml(inv.id)}">
      <span class="d">${escapeHtml(inv.date || '—')}</span>
      <span class="v">${escapeHtml(inv.vendor || '(no vendor)')}${inv.assets?.length ? ` <span class="dim">· ${inv.assets.length} file${inv.assets.length === 1 ? '' : 's'}</span>` : ''}</span>
      <span class="t">${inv.total_cents != null ? fmtMoney(inv.total_cents) : '—'}</span>
    </div>
  `).join('');
  // Clicking an invoice row jumps to the invoices tab and opens it
  $$('.pi', slot).forEach(row => {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const iid = row.dataset.invoiceId;
      switchTab('invoices');
      // Open the invoice card
      state.openInvoices.add(iid);
      setTimeout(() => {
        const card = document.querySelector(`.invoice[data-id="${iid}"]`);
        if (card) {
          card.classList.add('open');
          lazyLoadInvoiceBody(card);
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 50);
    });
  });
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
  // Pending tab is now exclusively the "Yet to place" list — parts the user
  // has flagged with status=to_order. Anything not in that bucket is hidden.
  const re = $('#reorderList');
  const reE = $('#reorderEmpty');
  const toOrder = (state.parts || []).filter(p => p.status === 'to_order');

  if (!toOrder.length) {
    re.innerHTML = '';
    reE.hidden = false;
    return;
  }
  reE.hidden = true;

  // Sort by total planned cost descending — biggest line items at the top.
  toOrder.sort((a, b) => {
    const ac = (a.unit_cost_cents || 0) * Math.max(a.target_min || 0, 1);
    const bc = (b.unit_cost_cents || 0) * Math.max(b.target_min || 0, 1);
    return bc - ac;
  });

  re.innerHTML = toOrder.map(p => {
    const planQty = p.target_min || 1;
    const total = (p.unit_cost_cents || 0) * planQty;
    return `
      <div class="reorder-row">
        <div class="nm tight">${escapeHtml(p.name)}
          ${p.supplier ? `<span class="sup">${escapeHtml(p.supplier)}${p.category ? ' · ' + escapeHtml(p.category) : ''}</span>` : (p.category ? `<span class="sup">${escapeHtml(p.category)}</span>` : '')}
        </div>
        <div class="qty"><span style="color:var(--text)">${planQty}</span> <span class="tgt">planned · ${total ? fmtMoney(total, { compact: true }) : '—'}</span></div>
        <button class="pill sm ghost" data-act="order" data-id="${escapeHtml(p.id)}">order +</button>
      </div>
    `;
  }).join('');
  $$('#reorderList [data-act="order"]').forEach(b => b.addEventListener('click', (e) => {
    openActDialog(e.currentTarget.dataset.id, 'order');
  }));
}

// ====================== invoices ======================

function renderInvoices() {
  const list = $('#invoicesList');
  const empty = $('#invoicesEmpty');
  // Apply client-side filters (vendor / sort handled by API, q done here)
  const q = state.filter.invQ.toLowerCase().trim();
  let rows = state.invoices.slice();
  if (q) {
    rows = rows.filter(i =>
      (i.vendor || '').toLowerCase().includes(q) ||
      (i.notes  || '').toLowerCase().includes(q) ||
      (i.parts || []).some(p => (p.name || '').toLowerCase().includes(q))
    );
  }
  $('#invCount').textContent = `${rows.length} invoice${rows.length === 1 ? '' : 's'}`;
  renderInvoiceVendorFilter();
  renderInvoiceActive();

  if (!rows.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = rows.map(i => {
    const parts = (i.parts || []).map(p => p.name).join(' · ') || '—';
    const fileCount = (i.assets || []).length;
    return `
      <div class="invoice" data-id="${escapeHtml(i.id)}">
        <div class="invoice-head">
          <div class="i-date">${escapeHtml(i.date || '—')}</div>
          <div class="i-vendor tight">${escapeHtml(i.vendor || '(no vendor)')}</div>
          <div class="i-parts" title="${escapeHtml(parts)}">${escapeHtml(parts)}</div>
          <div class="i-total">${i.total_cents != null ? fmtMoney(i.total_cents) : '—'}</div>
          <div class="i-files">${fileCount ? fileCount + (fileCount === 1 ? ' file' : ' files') : ''}</div>
          <div class="i-arrow">→</div>
        </div>
        <div class="invoice-body" data-loaded="0"></div>
      </div>
    `;
  }).join('');

  $$('.invoice', list).forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('a, button, .act')) return;
      const id = el.dataset.id;
      if (state.openInvoices.has(id)) state.openInvoices.delete(id);
      else state.openInvoices.add(id);
      el.classList.toggle('open');
      lazyLoadInvoiceBody(el);
    });
    if (state.openInvoices.has(el.dataset.id)) {
      el.classList.add('open');
      lazyLoadInvoiceBody(el);
    }
  });
}

function lazyLoadInvoiceBody(el) {
  const body = $('.invoice-body', el);
  if (body.dataset.loaded === '1') return;
  const i = state.invoices.find(x => x.id === el.dataset.id);
  if (!i) return;
  body.dataset.loaded = '1';

  const partsList = (i.parts || []).map(p => `
    <div class="ipl">
      <span>${escapeHtml(p.name)}</span>
      <span class="cat">${escapeHtml(p.category || '')}</span>
    </div>
  `).join('') || '<div class="dim mono cap" style="padding:.6rem 0">no parts linked</div>';

  const assets = (i.assets || []).map(a => {
    const isImg = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(a.path);
    const url = '/' + a.path.replace(/^\/+/, '');
    if (isImg) return `<a href="${escapeHtml(url)}" target="_blank"><img loading="lazy" src="${escapeHtml(url)}" alt=""></a>`;
    return `<a href="${escapeHtml(url)}" target="_blank" class="file">
      <span class="ext">${escapeHtml(fileExt(a.name) || 'file')}</span>
      <span class="fname">${escapeHtml(a.name)}</span>
      <span class="fsize">${escapeHtml(fmtBytes(a.size))}</span>
    </a>`;
  }).join('');

  const canEdit = true;
  body.innerHTML = `
    <div class="invoice-body-inner">
      <div>
        <div class="part-section-cap">Parts on this invoice</div>
        <div class="invoice-parts-list">${partsList}</div>
        ${i.notes ? `<div class="part-section-cap" style="margin-top:1.5rem">Notes</div>
                     <div class="invoice-notes">${escapeHtml(i.notes)}</div>` : ''}
        ${assets ? `<div class="part-section-cap" style="margin-top:1.5rem">Files</div>
                    <div class="part-assets">${assets}</div>` : ''}
        <div class="invoice-meta">
          <span>created ${escapeHtml(new Date(i.created_at).toLocaleString())}</span>
          <span>id ${escapeHtml(i.id.slice(0, 6))}</span>
          ${canEdit ? `<span class="meta-actions">
            <span class="act" data-act="edit" data-id="${escapeHtml(i.id)}">edit</span>
            <span class="act danger" data-act="del" data-id="${escapeHtml(i.id)}">delete</span>
          </span>` : ''}
        </div>
      </div>
      <div>
        <div class="part-section-cap">Summary</div>
        <div class="bigstat" style="margin-bottom:.5rem">
          <div class="num">${i.total_cents != null ? fmtMoney(i.total_cents) : '—'}</div>
          <div class="lbl">total</div>
        </div>
        <div class="part-meta" style="border-top:0; padding-top:0; margin-top:.5rem">
          <span>vendor ${escapeHtml(i.vendor || '—')}</span>
          <span>date ${escapeHtml(i.date || '—')}</span>
        </div>
      </div>
    </div>
  `;
  $$('.act', body).forEach(b => b.addEventListener('click', onInvoiceAction));
}

function renderInvoiceVendorFilter() {
  const box = $('#invVendorFilters');
  if (!state.vendors.length) { box.innerHTML = ''; return; }
  box.innerHTML = state.vendors.slice(0, 10).map(v => `
    <button class="c ${state.filter.invVendor === v ? 'on' : ''}" data-vendor="${escapeHtml(v)}">${escapeHtml(v)}</button>
  `).join('');
  $$('button.c', box).forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.vendor;
      state.filter.invVendor = state.filter.invVendor === v ? null : v;
      renderInvoiceVendorFilter();
      refreshInvoices();
    });
  });
}

function renderInvoiceActive() {
  const f = state.filter;
  const bits = [];
  if (f.invVendor) bits.push(`vendor: ${f.invVendor}`);
  if (f.invQ) bits.push(`"${f.invQ}"`);
  const box = $('#invActive');
  if (!bits.length) { box.innerHTML = ''; return; }
  box.innerHTML = `${escapeHtml(bits.join(' · '))} <span class="clear" id="clearInvFilters">clear</span>`;
  $('#clearInvFilters').addEventListener('click', () => {
    state.filter.invQ = ''; state.filter.invVendor = null;
    $('#invSearchInput').value = '';
    renderInvoiceVendorFilter(); renderInvoiceActive();
    refreshInvoices();
  });
}

async function onInvoiceAction(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const b = ev.currentTarget;
  const id = b.dataset.id;
  const act = b.dataset.act;
  const i = state.invoices.find(x => x.id === id);
  if (!i) return;
  if (act === 'edit') { openInvoiceDialog(i); return; }
  if (act === 'del') {
    if (!confirm('Delete this invoice? The .md file will be removed; attached PDFs stay on disk.')) return;
    try {
      await api(`/api/invoices/${id}`, { method: 'DELETE' });
      state.openInvoices.delete(id);
      await refreshAll(); renderAll();
      toast('deleted');
    } catch (err) { toast('failed: ' + err.message, 'err'); }
  }
}

function openInvoiceDialog(invoice) {
  const dlg = $('#invoiceDialog');
  const form = $('#invoiceForm');
  form.reset();
  state.invoiceDialog.pickerFilter = '';

  if (invoice) {
    state.invoiceDialog.mode = 'edit';
    state.invoiceDialog.editingId = invoice.id;
    $('#invoiceDialogKind').textContent = 'Edit invoice';
    $('#invoiceDialogTitle').textContent = invoice.vendor || 'Invoice';
    $('#saveInvoice').textContent = 'save changes →';
    $('#deleteInvoice').hidden = false;
    form.elements.id.value = invoice.id;
    form.elements.vendor.value = invoice.vendor || '';
    form.elements.date.value = invoice.date || '';
    form.elements.total.value = invoice.total_cents != null ? (invoice.total_cents / 100).toFixed(2) : '';
    form.elements.notes.value = invoice.notes || '';
    state.invoiceDialog.pickedParts = new Set((invoice.parts || []).map(p => p.id));
    state.invoiceDialog.existingAssets = invoice.assets || [];
  } else {
    state.invoiceDialog.mode = 'add';
    state.invoiceDialog.editingId = null;
    $('#invoiceDialogKind').textContent = 'Add invoice';
    $('#invoiceDialogTitle').textContent = 'New invoice.';
    $('#saveInvoice').textContent = 'save invoice →';
    $('#deleteInvoice').hidden = true;
    state.invoiceDialog.pickedParts = new Set();
    state.invoiceDialog.existingAssets = [];
    // Default date to today
    form.elements.date.valueAsDate = new Date();
  }

  // Vendor datalist
  $('#vendorSuggest').innerHTML = (state.vendors || []).map(v =>
    `<option value="${escapeHtml(v)}">`).join('');

  renderPartPicker();
  renderInvoiceExistingAssets();
  dlg.hidden = false;
  setTimeout(() => form.elements.vendor.focus(), 30);
}

function closeInvoiceDialog() {
  $('#invoiceDialog').hidden = true;
  $('#invoiceForm').reset();
  state.invoiceDialog.editingId = null;
  state.invoiceDialog.pickedParts = new Set();
  state.invoiceDialog.existingAssets = [];
  state.invoiceDialog.pickerFilter = '';
}

function renderPartPicker() {
  const sel = $('#partPickerSelected');
  const list = $('#partPickerList');
  const picked = state.invoiceDialog.pickedParts;

  // Selected chips (from the full state.parts so names resolve)
  sel.innerHTML = Array.from(picked).map(pid => {
    const p = state.parts.find(x => x.id === pid);
    if (!p) return '';
    return `<span class="chip" data-id="${escapeHtml(pid)}">${escapeHtml(p.name)} <span class="x">×</span></span>`;
  }).join('');
  $$('#partPickerSelected .chip .x').forEach(x => x.addEventListener('click', (ev) => {
    const id = ev.currentTarget.parentElement.dataset.id;
    picked.delete(id);
    renderPartPicker();
  }));

  // Filtered list of all parts
  const f = state.invoiceDialog.pickerFilter.toLowerCase().trim();
  const visible = (state.parts || []).filter(p =>
    !f || p.name.toLowerCase().includes(f) ||
    (p.supplier || '').toLowerCase().includes(f) ||
    (p.category || '').toLowerCase().includes(f)
  );
  list.innerHTML = visible.map(p => `
    <div class="row ${picked.has(p.id) ? 'on' : ''}" data-id="${escapeHtml(p.id)}">
      <span class="box"></span>
      <span>${escapeHtml(p.name)}</span>
      <span class="cat">${escapeHtml(p.category || '')}</span>
    </div>
  `).join('') || '<div class="dim mono cap" style="padding:.6rem .8rem">no matches</div>';

  $$('#partPickerList .row').forEach(r => {
    r.addEventListener('click', () => {
      const id = r.dataset.id;
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      renderPartPicker();
    });
  });
}

function renderInvoiceExistingAssets() {
  const box = $('#invoiceExistingAssets');
  const items = state.invoiceDialog.existingAssets || [];
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = items.map(a => {
    const url = '/' + a.path.replace(/^\/+/, '');
    return `<a class="ea" href="${escapeHtml(url)}" target="_blank">${escapeHtml(a.name)}</a>`;
  }).join('');
}

function bindInvoiceDialog() {
  $('#openInvoiceAdd').addEventListener('click', () => openInvoiceDialog(null));
  $('#cancelInvoice').addEventListener('click', closeInvoiceDialog);
  $('#invoiceDialog').addEventListener('click', (ev) => {
    if (ev.target === $('#invoiceDialog')) closeInvoiceDialog();
  });
  $('#deleteInvoice').addEventListener('click', async () => {
    const id = state.invoiceDialog.editingId;
    if (!id) return;
    if (!confirm('Delete this invoice?')) return;
    try {
      await api(`/api/invoices/${id}`, { method: 'DELETE' });
      state.openInvoices.delete(id);
      closeInvoiceDialog();
      await refreshAll(); renderAll();
      toast('deleted');
    } catch (err) { toast('failed: ' + err.message, 'err'); }
  });
  $('#partPickerSearch').addEventListener('input', (e) => {
    state.invoiceDialog.pickerFilter = e.target.value;
    renderPartPicker();
  });
  $('#invoiceForm').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      $('#invoiceForm').requestSubmit();
    }
  });
  $('#invoiceForm').addEventListener('submit', onInvoiceSubmit);

  $('#invSearchInput').addEventListener('input', (e) => {
    clearTimeout($('#invSearchInput')._h);
    $('#invSearchInput')._h = setTimeout(() => {
      state.filter.invQ = e.target.value.trim();
      renderInvoices();
    }, 200);
  });
  $('#invSortSelect').addEventListener('change', (e) => {
    state.filter.invSort = e.target.value;
    refreshInvoices();
  });
}

async function onInvoiceSubmit(ev) {
  ev.preventDefault();
  const f = ev.target;
  const submitBtn = $('#saveInvoice');
  if (submitBtn.disabled) return;
  submitBtn.disabled = true;
  try {
    if (state.invoiceDialog.mode === 'edit') {
      await submitInvoiceEdit(f);
    } else {
      await submitInvoiceCreate(f);
    }
    closeInvoiceDialog();
    await refreshAll(); renderAll();
    toast(state.invoiceDialog.mode === 'edit' ? 'saved' : 'invoice added');
  } catch (err) {
    toast('failed: ' + err.message, 'err');
  } finally {
    submitBtn.disabled = false;
  }
}

async function submitInvoiceCreate(f) {
  const fd = new FormData();
  for (const name of ['vendor', 'total', 'date', 'notes']) {
    const v = f.elements[name].value;
    if (v) fd.set(name, v);
  }
  fd.set('part_ids', JSON.stringify(Array.from(state.invoiceDialog.pickedParts)));
  for (const file of f.elements.files.files || []) fd.append('files', file);
  await apiForm('/api/invoices', fd);
}

async function submitInvoiceEdit(f) {
  const id = state.invoiceDialog.editingId;
  const body = {
    vendor: f.elements.vendor.value.trim() || null,
    date:   f.elements.date.value || null,
    notes:  f.elements.notes.value,
    part_ids: Array.from(state.invoiceDialog.pickedParts),
  };
  const total = f.elements.total.value;
  if (total) body.total = total;
  await api(`/api/invoices/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Upload any new files
  const files = f.elements.files.files || [];
  if (files.length) {
    const fd = new FormData();
    for (const file of files) fd.append('files', file);
    await apiForm(`/api/invoices/${id}/assets`, fd);
  }
}

function renderSpend() {
  const s = state.stats;
  const spent    = s.total_spent_cents      || 0;
  const planned  = s.planned_expenses_cents || 0;
  const budget   = s.budget_cents           || 0;
  const remain   = s.remaining_balance_cents != null
    ? s.remaining_balance_cents : (budget - spent);

  const items = [
    { num: fmtMoney(spent),   lbl: 'total spent',       sub: 'in house · in transit · placed' },
    { num: fmtMoney(planned), lbl: 'planned expenses',  sub: 'yet to be placed · not in total' },
    { num: fmtMoney(remain),  lbl: 'remaining balance', sub: `of ${fmtMoney(budget)}`,
      neg: remain < 0 },
    { num: fmtMoney(budget),  lbl: 'budget' },
  ];
  $('#spendStats').innerHTML = items.map(it => `
    <div class="bigstat">
      <div class="num ${it.neg ? 'neg' : ''}">${it.num}</div>
      <div class="lbl">${escapeHtml(it.lbl)}</div>
      ${it.sub ? `<div class="sub">${escapeHtml(it.sub)}</div>` : ''}
    </div>
  `).join('');

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

// ====================== part dialog (add + edit) ======================

function bindPartDialog() {
  $('#openAdd').addEventListener('click', () => openPartDialog(null));
  $('#cancelPart').addEventListener('click', () => closePartDialog());
  $('#partDialog').addEventListener('click', (ev) => {
    if (ev.target === $('#partDialog')) closePartDialog();
  });
  $('#partForm').addEventListener('submit', onPartSubmit);

  // Cmd+Enter / Ctrl+Enter submits, even from textarea
  $('#partForm').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      $('#partForm').requestSubmit();
    }
  });

  // Category chip cloud (live)
  // Tag chip cloud (live) — both wired in renderPartDialogSuggestions

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

function openPartDialog(part) {
  const dlg = $('#partDialog');
  const form = $('#partForm');
  form.reset();
  state.partDialog.removedAssets = new Set();
  state.partDialog.existingAssets = [];

  if (part) {
    // Edit mode
    state.partDialog.mode = 'edit';
    state.partDialog.editingId = part.id;
    $('#partDialogKind').textContent = 'Edit part';
    $('#partDialogTitle').textContent = part.name;
    $('#savePart').textContent = 'save changes →';
    form.elements.id.value = part.id;
    form.elements.name.value = part.name || '';
    form.elements.category.value = part.category || '';
    form.elements.supplier.value = part.supplier || '';
    form.elements.link.value = part.link || '';
    form.elements.unit.value = part.unit || 'each';
    form.elements.unit_cost.value = part.unit_cost_cents != null
      ? (part.unit_cost_cents / 100).toFixed(2) : '';
    form.elements.on_hand.value = part.on_hand ?? 0;
    form.elements.status.value = part.status || '';
    form.elements.date.value = part.date || '';
    form.elements.target_min.value = part.target_min ?? 0;
    form.elements.tags.value = (part.tags || []).join(', ');
    form.elements.notes.value = part.notes || '';
    state.partDialog.pickedCat = part.category || null;
    state.partDialog.pickedTags = new Set(part.tags || []);
    state.partDialog.existingAssets = part.assets || [];
  } else {
    // Add mode
    state.partDialog.mode = 'add';
    state.partDialog.editingId = null;
    $('#partDialogKind').textContent = 'Add part';
    $('#partDialogTitle').textContent = 'New part.';
    $('#savePart').textContent = 'save part →';
    state.partDialog.pickedCat = null;
    state.partDialog.pickedTags = new Set();
  }

  renderPartDialogSuggestions();
  renderExistingAssets();

  // Re-render chips live so the "picked" state stays accurate as user types.
  if (!form._suggBound) {
    form.elements.category.addEventListener('input', () => renderPartDialogSuggestions());
    form.elements.tags.addEventListener('input', () => renderPartDialogSuggestions());
    form._suggBound = true;
  }

  dlg.hidden = false;
  setTimeout(() => form.elements.name.focus(), 30);
}

function closePartDialog() {
  $('#partDialog').hidden = true;
  $('#partForm').reset();
  state.partDialog.editingId = null;
  state.partDialog.pickedTags = new Set();
  state.partDialog.pickedCat = null;
  state.partDialog.existingAssets = [];
  state.partDialog.removedAssets = new Set();
}

function renderPartDialogSuggestions() {
  // Category datalist + chips
  const catDl = $('#catSuggest');
  catDl.innerHTML = (state.categories || []).map(c =>
    `<option value="${escapeHtml(c)}">`).join('');
  const catChips = $('#catChips');
  if (!state.categories.length) {
    catChips.innerHTML = '<span class="empty">no categories yet — type one to create</span>';
  } else {
    const current = $('#partForm').elements.category.value.trim();
    catChips.innerHTML = state.categories.slice(0, 12).map(c => `
      <span class="sug ${current === c ? 'picked' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</span>
    `).join('');
    $$('.sug', catChips).forEach(b => b.addEventListener('click', () => {
      $('#partForm').elements.category.value = b.dataset.cat;
      renderPartDialogSuggestions();
    }));
  }

  // Tag datalist + chips (multi-select)
  const tagDl = $('#tagSuggest');
  tagDl.innerHTML = (state.tagNames || []).map(t =>
    `<option value="${escapeHtml(t)}">`).join('');
  const tagChips = $('#tagChips');
  if (!state.tagNames.length) {
    tagChips.innerHTML = '<span class="empty">no tags yet — type comma-separated</span>';
  } else {
    const cur = parseTagsInput($('#partForm').elements.tags.value);
    tagChips.innerHTML = state.tagNames.slice(0, 30).map(t => `
      <span class="sug ${cur.has(t) ? 'picked' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>
    `).join('');
    $$('.sug', tagChips).forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.tag;
      const input = $('#partForm').elements.tags;
      const set = parseTagsInput(input.value);
      if (set.has(t)) set.delete(t); else set.add(t);
      input.value = Array.from(set).join(', ');
      renderPartDialogSuggestions();
    }));
  }
}

function renderExistingAssets() {
  const box = $('#existingAssets');
  const items = state.partDialog.existingAssets || [];
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  // Read-only list of attachments already on the part — clicking opens them.
  // (Removing files isn't supported by the API yet; this is informational.)
  box.innerHTML = items.map(a => {
    const url = '/' + a.path.replace(/^\/+/, '');
    return `<a class="ea" href="${escapeHtml(url)}" target="_blank">${escapeHtml(a.name)}</a>`;
  }).join('');
}

function parseTagsInput(s) {
  return new Set(
    (s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  );
}

async function onPartSubmit(ev) {
  ev.preventDefault();
  const f = ev.target;
  const submitBtn = $('#savePart');
  if (submitBtn.disabled) return;
  submitBtn.disabled = true;
  try {
    if (state.partDialog.mode === 'edit') {
      await submitPartEdit(f);
    } else {
      await submitPartCreate(f);
    }
    closePartDialog();
    await refreshAll(); renderAll();
    toast(state.partDialog.mode === 'edit' ? 'saved' : 'part added');
  } catch (err) {
    toast('failed: ' + err.message, 'err');
  } finally {
    submitBtn.disabled = false;
  }
}

async function submitPartCreate(f) {
  const fd = new FormData();
  for (const name of ['name','category','supplier','link','unit','on_hand','target_min','status','date','tags','notes']) {
    const v = f.elements[name]?.value || '';
    if (v) fd.set(name, v);
  }
  const cost = f.elements.unit_cost.value;
  if (cost) fd.set('unit_cost_cents', String(Math.round(parseFloat(cost) * 100)));
  for (const file of f.elements.files.files || []) fd.append('files', file);
  await apiForm('/api/parts', fd);
}

async function submitPartEdit(f) {
  const id = state.partDialog.editingId;
  // 1) PATCH the metadata
  const body = {
    name: f.elements.name.value.trim(),
    category: f.elements.category.value.trim(),
    supplier: f.elements.supplier.value.trim(),
    link: f.elements.link.value.trim(),
    unit: f.elements.unit.value,
    on_hand: parseFloat(f.elements.on_hand.value) || 0,
    target_min: parseFloat(f.elements.target_min.value) || 0,
    status: f.elements.status.value || null,
    date: f.elements.date.value || null,
    notes: f.elements.notes.value,
    tags: Array.from(parseTagsInput(f.elements.tags.value)),
  };
  const cost = f.elements.unit_cost.value;
  body.unit_cost_cents = cost ? Math.round(parseFloat(cost) * 100) : null;
  await api(`/api/parts/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // 2) If files added, POST them as additional assets
  const files = f.elements.files.files || [];
  if (files.length) {
    const fd = new FormData();
    for (const file of files) fd.append('files', file);
    await apiForm(`/api/parts/${id}/assets`, fd);
  }
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
  openPartDialog(p);
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
    // Number keys 1-5 switch tabs
    if (['1','2','3','4','5'].includes(ev.key) && !/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) {
      switchTab(['stock','activity','pending','invoices','spend'][parseInt(ev.key, 10) - 1]);
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
