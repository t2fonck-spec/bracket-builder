'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  user: null,
  token: null,
  view: null,
  bracketData: null,
  currentSlug: null,
  managingSlug: null,
  voteQueue: [],
  voteIndex: 0,
  pollTimer: null,
  zoom: 1,
  display: { seeds: true, scores: true, roundTitles: true }, // persisted to localStorage
};

// ─── CSS helpers ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');
const setHidden = (id, cond) => cond ? hide(id) : show(id);

// ─── API Client ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.upgrade = data.upgrade;
    throw err;
  }
  return data;
}

// ─── Auth Persistence ─────────────────────────────────────────────────────────
function loadAuth() {
  try {
    state.token = localStorage.getItem('bb_token');
    const raw = localStorage.getItem('bb_user');
    state.user = raw ? JSON.parse(raw) : null;
    const disp = localStorage.getItem('bb_display');
    if (disp) state.display = { ...state.display, ...JSON.parse(disp) };
  } catch {}
}
function saveDisplay() {
  localStorage.setItem('bb_display', JSON.stringify(state.display));
}
function saveAuth(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('bb_token', token);
  localStorage.setItem('bb_user', JSON.stringify(user));
}
function clearAuth() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('bb_token');
  localStorage.removeItem('bb_user');
}

// ─── View Management ──────────────────────────────────────────────────────────
const VIEWS = ['auth-view', 'dashboard-view', 'manage-view', 'bracket-view'];
function showView(name) {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  VIEWS.forEach(v => hide(v));
  show(name + '-view');
  state.view = name;
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function route(path) {
  path = path || window.location.pathname;
  const slug = path.replace(/^\//, '').replace(/\/$/, '');

  if (!slug || slug === '') {
    if (state.user) {
      await showDashboard();
    } else {
      showAuth();
    }
    return;
  }

  // Try to load bracket by slug
  try {
    const data = await api('GET', `/api/brackets/${slug}`);
    await showBracketView(data);
  } catch (e) {
    if (e.status === 404) {
      if (state.user) await showDashboard();
      else showAuth();
    } else {
      showAuth();
    }
  }
}

function navigate(path) {
  window.history.pushState({}, '', path);
  route(path);
}

window.addEventListener('popstate', () => route());

// ─── Check for upgrade/cancel params ─────────────────────────────────────────
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('upgraded') === '1') {
    // Re-fetch user to get updated tier
    api('GET', '/api/me').then(user => {
      saveAuth(state.token, user);
      renderHeaderTier();
    }).catch(() => {});
    window.history.replaceState({}, '', '/');
  }
  if (params.get('cancelled') === '1') {
    window.history.replaceState({}, '', '/');
  }
}

// ─── Auth View ────────────────────────────────────────────────────────────────
function showAuth() {
  showView('auth');
}

let authMode = 'login';

document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    authMode = btn.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b === btn));
    $('auth-submit').textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
    hide('auth-error');
  });
});

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  hide('auth-error');
  const email    = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const btn = $('auth-submit');
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  try {
    const data = await api('POST', `/api/${authMode}`, { email, password });
    saveAuth(data.token, data.user);
    $('auth-password').value = '';
    await showDashboard();
  } catch (e) {
    $('auth-error').textContent = e.message;
    show('auth-error');
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
  }
});

// ─── Dashboard View ───────────────────────────────────────────────────────────
async function showDashboard() {
  showView('dashboard');
  navigate('/');
  renderHeaderTier();
  $('header-email').textContent = state.user.email;

  // Show upgrade banner for free users
  setHidden('upgrade-banner', state.user.tier !== 'free');

  hide('brackets-empty');
  $('brackets-list').innerHTML = '<p style="color:var(--text-3);font-size:14px;">Loading…</p>';

  try {
    const brackets = await api('GET', '/api/brackets');
    renderBracketCards(brackets);
  } catch (e) {
    $('brackets-list').innerHTML = '';
    show('brackets-empty');
  }
}

function renderHeaderTier() {
  const badge = $('header-tier-badge');
  if (!badge) return;
  if (state.user?.tier === 'pro') {
    badge.textContent = 'PRO';
    badge.className = 'badge badge-pro';
  } else {
    badge.textContent = 'FREE';
    badge.className = 'badge badge-free';
  }
}

function renderBracketCards(brackets) {
  const list = $('brackets-list');
  list.innerHTML = '';
  if (!brackets.length) {
    show('brackets-empty');
    return;
  }
  hide('brackets-empty');
  for (const b of brackets) {
    const card = document.createElement('div');
    card.className = 'bracket-card';
    const statusClass = { setup: 'badge-setup', active: 'badge-active', complete: 'badge-complete' }[b.status] || '';
    card.innerHTML = `
      <div class="bracket-card-top">
        <div class="bracket-card-title">${esc(b.title)}</div>
      </div>
      <div class="bracket-card-meta">
        <span class="badge ${statusClass}">${b.status}</span>
        <span class="badge badge-free">${b.size}-team</span>
        <span class="badge badge-free">${b.participant_count}/${b.size} added</span>
      </div>
      <div class="bracket-card-actions">
        <button class="btn btn-ghost btn-sm" data-action="view" data-slug="${b.slug}">View</button>
        ${b.status === 'setup' ? `<button class="btn btn-ghost btn-sm" data-action="manage" data-slug="${b.slug}" data-id="${b.id}">Manage</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${b.id}" data-title="${esc(b.title)}">Delete</button>
      </div>
    `;
    list.appendChild(card);
  }
}

$('brackets-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, slug, id, title } = btn.dataset;
  if (action === 'view') {
    navigate('/' + slug);
  } else if (action === 'manage') {
    await showManageView(slug);
  } else if (action === 'delete') {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/brackets/${id}`);
      await showDashboard();
    } catch (e) { alert(e.message); }
  }
});

$('logout-btn').addEventListener('click', () => {
  clearAuth();
  showAuth();
});

$('upgrade-btn')?.addEventListener('click', startCheckout);

// ─── Create Bracket Modal ─────────────────────────────────────────────────────
$('new-bracket-btn').addEventListener('click', () => {
  hide('create-error');
  $('b-title').value = '';
  setSelectedSize(8);
  show('create-modal');
  $('b-title').focus();
});

function setSelectedSize(size) {
  document.querySelectorAll('.size-option').forEach(opt => {
    const isSelected = Number(opt.dataset.size) === size;
    opt.classList.toggle('selected', isSelected);
    const radio = opt.querySelector('input[type=radio]');
    if (radio) radio.checked = isSelected;
  });
  const needsPro = size > 8;
  const isFree = state.user?.tier === 'free';
  setHidden('size-upgrade-note', !(needsPro && isFree));
}

$('size-options').addEventListener('click', e => {
  const opt = e.target.closest('.size-option');
  if (!opt) return;
  setSelectedSize(Number(opt.dataset.size));
});

function closeCreateModal() {
  hide('create-modal');
}
$('create-modal-close').addEventListener('click', closeCreateModal);
$('create-cancel-btn').addEventListener('click', closeCreateModal);
$('size-upgrade-link')?.addEventListener('click', e => { e.preventDefault(); closeCreateModal(); startCheckout(); });

$('create-form').addEventListener('submit', async e => {
  e.preventDefault();
  hide('create-error');
  const title = $('b-title').value.trim();
  const size = Number(document.querySelector('.size-option.selected')?.dataset.size || 8);
  if (!title) return;
  try {
    const bracket = await api('POST', '/api/brackets', { title, size });
    closeCreateModal();
    await showManageView(bracket.slug);
  } catch (err) {
    if (err.upgrade) {
      $('create-error').innerHTML = `Pro tier required. <a href="#" id="create-upgrade-link">Upgrade for $2.99</a>`;
      document.getElementById('create-upgrade-link')?.addEventListener('click', e => { e.preventDefault(); closeCreateModal(); startCheckout(); });
    } else {
      $('create-error').textContent = err.message;
    }
    show('create-error');
  }
});

// ─── Manage View ──────────────────────────────────────────────────────────────
async function showManageView(slug) {
  state.managingSlug = slug;
  showView('manage');
  window.history.pushState({}, '', '/');
  $('manage-title').textContent = 'Loading…';
  $('participants-list').innerHTML = '';
  hide('share-block');
  $('start-bracket-btn').disabled = true;
  try {
    const data = await api('GET', `/api/brackets/${slug}`);
    await showManageViewWithData(data);
  } catch (e) {
    alert('Failed to load bracket: ' + e.message);
    await showDashboard();
  }
}

function renderParticipants(participants, bracket) {
  const list = $('participants-list');
  list.innerHTML = '';
  const canEdit = bracket.status === 'setup';
  for (const p of participants) {
    const li = document.createElement('li');
    li.className = 'participant-item';
    li.dataset.id = p.id;
    li.dataset.seed = p.seed;
    if (canEdit) li.draggable = true;
    li.innerHTML = `
      ${canEdit ? '<span class="drag-handle" title="Drag to reorder">⠿</span>' : ''}
      <span class="participant-seed">#${p.seed}</span>
      ${p.img
        ? `<img class="participant-img" src="${esc(p.img)}" alt="" onerror="this.style.display='none'">`
        : `<div class="participant-img-placeholder">${esc(p.name[0].toUpperCase())}</div>`
      }
      <span class="participant-name">${esc(p.name)}</span>
      ${canEdit ? `<button class="btn btn-danger btn-sm" data-pid="${p.id}">✕</button>` : ''}
    `;
    list.appendChild(li);
  }
  if (canEdit) attachDragHandlers();
}

async function showManageViewWithData(data) {
  const { bracket, participants } = data;
  $('manage-title').textContent = bracket.title;
  $('manage-size-badge').textContent = `${bracket.size}-team`;
  $('manage-size-badge').className = `badge ${bracket.tier === 'pro' ? 'badge-pro' : 'badge-free'}`;
  $('bracket-desc').value = bracket.description || '';
  renderParticipants(participants, bracket);
  updateManageStatus(participants.length, bracket);
  if (bracket.status !== 'setup') {
    $('share-url').value = location.origin + '/' + bracket.slug;
    show('share-block');
    $('start-bracket-btn').classList.add('hidden');
  }
}

$('participants-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-pid]');
  if (!btn) return;
  const pid = btn.dataset.pid;
  try {
    await api('DELETE', `/api/brackets/${state.managingSlug}/participants/${pid}`);
    await refreshManageView();
  } catch (e) { alert(e.message); }
});

async function refreshManageView() {
  try {
    const data = await api('GET', `/api/brackets/${state.managingSlug}`);
    await showManageViewWithData(data);
  } catch {}
}

function updateManageStatus(count, bracket) {
  $('manage-count-badge').textContent = `${count}/${bracket.size}`;
  $('manage-count-badge').className = count === bracket.size ? 'badge badge-active' : 'badge badge-setup';

  const ready = count === bracket.size;
  $('start-bracket-btn').disabled = !ready;

  const msg = $('manage-status-msg');
  if (bracket.status === 'active') {
    msg.textContent = 'Bracket is live — votes are open.';
    msg.className = 'status-msg ready';
    $('start-bracket-btn').classList.add('hidden');
    $('share-url').value = location.origin + '/' + bracket.slug;
    show('share-block');
  } else if (bracket.status === 'complete') {
    msg.textContent = 'Bracket complete.';
    msg.className = 'status-msg ready';
    $('start-bracket-btn').classList.add('hidden');
  } else if (ready) {
    msg.textContent = `All ${bracket.size} participants added. Ready to start!`;
    msg.className = 'status-msg ready';
  } else {
    msg.textContent = `Add ${bracket.size - count} more participant${bracket.size - count !== 1 ? 's' : ''} to start.`;
    msg.className = 'status-msg';
  }
}

$('add-participant-form').addEventListener('submit', async e => {
  e.preventDefault();
  hide('add-p-error');
  const name = $('p-name').value.trim();
  const img  = $('p-img').value.trim();
  if (!name) return;
  try {
    await api('POST', `/api/brackets/${state.managingSlug}/participants`, { name, img: img || null });
    $('p-name').value = '';
    $('p-img').value = '';
    $('p-name').focus();
    await refreshManageView();
  } catch (e) {
    $('add-p-error').textContent = e.message;
    show('add-p-error');
  }
});

$('start-bracket-btn').addEventListener('click', async () => {
  try {
    await api('POST', `/api/brackets/${state.managingSlug}/start`);
    navigate('/' + state.managingSlug);
  } catch (e) { alert(e.message); }
});

$('manage-back-btn').addEventListener('click', () => showDashboard());

// ─── Description auto-save ────────────────────────────────────────────────────
let _descTimer;
$('bracket-desc').addEventListener('input', () => {
  clearTimeout(_descTimer);
  _descTimer = setTimeout(async () => {
    const desc = $('bracket-desc').value.trim();
    try { await api('PATCH', `/api/brackets/${state.managingSlug}`, { description: desc }); } catch {}
  }, 800);
});

// ─── Shuffle ─────────────────────────────────────────────────────────────────
$('shuffle-btn').addEventListener('click', async () => {
  try {
    await api('POST', `/api/brackets/${state.managingSlug}/participants/shuffle`);
    await refreshManageView();
  } catch (e) { alert(e.message); }
});

// ─── Bulk Add Modal ───────────────────────────────────────────────────────────
$('bulk-add-btn').addEventListener('click', () => {
  $('bulk-names').value = '';
  hide('bulk-error');
  show('bulk-modal');
  $('bulk-names').focus();
});
$('bulk-modal-close').addEventListener('click', () => hide('bulk-modal'));
$('bulk-cancel-btn').addEventListener('click', () => hide('bulk-modal'));

$('bulk-submit-btn').addEventListener('click', async () => {
  hide('bulk-error');
  const names = $('bulk-names').value.split('\n').map(n => n.trim()).filter(Boolean);
  if (!names.length) return;
  try {
    const { added } = await api('POST', `/api/brackets/${state.managingSlug}/participants/bulk`, { names });
    hide('bulk-modal');
    await refreshManageView();
    if (added.length < names.length) {
      alert(`Added ${added.length} of ${names.length} (bracket may now be full).`);
    }
  } catch (e) {
    $('bulk-error').textContent = e.message;
    show('bulk-error');
  }
});

// ─── Drag-to-reorder participants ─────────────────────────────────────────────
let _dragId = null;

function attachDragHandlers() {
  const list = $('participants-list');
  list.querySelectorAll('.participant-item[draggable]').forEach(item => {
    item.addEventListener('dragstart', e => {
      _dragId = item.dataset.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.participant-item').forEach(i => i.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const targetId = item.dataset.id;
      if (!_dragId || _dragId === targetId) return;
      const targetSeed = Number(item.dataset.seed);
      try {
        await api('PATCH', `/api/brackets/${state.managingSlug}/participants/${_dragId}/seed`, { new_seed: targetSeed });
        await refreshManageView();
      } catch (err) { alert(err.message); }
      _dragId = null;
    });
  });
}

$('copy-url-btn').addEventListener('click', () => {
  const input = $('share-url');
  input.select();
  navigator.clipboard.writeText(input.value).catch(() => document.execCommand('copy'));
  $('copy-url-btn').textContent = 'Copied!';
  setTimeout(() => { $('copy-url-btn').textContent = 'Copy'; }, 1800);
});

// ─── Bracket View ─────────────────────────────────────────────────────────────
async function showBracketView(data) {
  showView('bracket');
  state.bracketData = data;
  state.currentSlug = data.bracket.slug;
  window.history.pushState({}, '', '/' + data.bracket.slug);

  const { bracket, participants, matchups, isOwner } = data;

  $('bracket-title').textContent = bracket.title;

  const statusClass = { setup: 'badge-setup', active: 'badge-active', complete: 'badge-complete' }[bracket.status] || '';
  $('bracket-status-badge').className = `badge ${statusClass}`;
  $('bracket-status-badge').textContent = bracket.status;

  // Vote Now button
  const hasActiveMatchups = matchups.some(m => !m.winner_id && m.participant_a_id && m.participant_b_id);
  setHidden('vote-now-btn', bracket.status !== 'active' || !hasActiveMatchups);
  setHidden('manage-bracket-btn', !isOwner || bracket.status !== 'setup');

  // Back button behaviour
  $('bracket-back-btn').onclick = () => {
    if (state.user) showDashboard();
    else { window.history.back(); }
  };

  $('manage-bracket-btn').onclick = () => showManageView(bracket.slug);

  initToolbar(isOwner);
  state.zoom = 1;
  updateZoomLabel();
  attachTitleEdit();

  renderBracket(bracket, participants, matchups, isOwner);
  renderChampion(bracket, participants, matchups);

  // Poll for updates when active
  if (bracket.status === 'active') {
    state.pollTimer = setInterval(async () => {
      try {
        const fresh = await api('GET', `/api/brackets/${state.currentSlug}`);
        state.bracketData = fresh;
        renderBracket(fresh.bracket, fresh.participants, fresh.matchups, fresh.isOwner);
        renderChampion(fresh.bracket, fresh.participants, fresh.matchups);
        const active = fresh.matchups.some(m => !m.winner_id && m.participant_a_id && m.participant_b_id);
        setHidden('vote-now-btn', fresh.bracket.status !== 'active' || !active);
      } catch {}
    }, 15000);
  }
}

// ─── Bracket Renderer ─────────────────────────────────────────────────────────
const CARD_H    = 76;
const SLOT_H    = 38;
const CARD_W    = 176;
const SPACER_W  = 48;
const ROUND_GAP = CARD_W + SPACER_W;
const V_PAD     = 16;

function calcMatchupPos(totalRounds, size, round, position) {
  // 1-indexed round and position
  const numMatchups = size / Math.pow(2, round);
  const totalH = size * (CARD_H / 2) + V_PAD * 2;  // height scales with bracket size
  const slotH  = (totalH - V_PAD * 2) / numMatchups;
  const y = V_PAD + slotH * (position - 1) + (slotH - CARD_H) / 2;
  const x = (round - 1) * ROUND_GAP;
  return { x, y, centerY: V_PAD + slotH * (position - 1) + slotH / 2 };
}

function renderBracket(bracket, participants, matchups, isOwner) {
  const container = $('bracket-rounds');
  container.innerHTML = '';

  const totalRounds = Math.log2(bracket.size);
  const totalH = bracket.size * (CARD_H / 2) + V_PAD * 2;
  const totalW = totalRounds * ROUND_GAP;

  // Set container size
  container.style.height = totalH + 'px';
  container.style.width  = totalW + 'px';

  // Index participants for quick lookup
  const pMap = {};
  participants.forEach(p => { pMap[p.id] = p; });

  // Render each round
  for (let r = 1; r <= totalRounds; r++) {
    const roundMatchups = matchups.filter(m => m.round === r).sort((a, b) => a.position - b.position);

    for (const m of roundMatchups) {
      const pos = calcMatchupPos(totalRounds, bracket.size, r, m.position);
      const card = buildMatchupCard(m, pMap, isOwner, bracket);
      card.style.top  = pos.y + 'px';
      card.style.left = pos.x + 'px';
      container.appendChild(card);
    }
  }

  // Draw connector lines
  drawBracketLines(bracket, matchups, totalH, totalW);

  // Round labels
  const labelsEl = $('bracket-round-labels');
  labelsEl.innerHTML = '';
  setHidden('bracket-round-labels', !state.display.roundTitles);
  if (state.display.roundTitles) {
    for (let r = 1; r <= totalRounds; r++) {
      const roundNames = { [totalRounds]: 'Final', [totalRounds - 1]: 'Semis', [totalRounds - 2]: 'Quarters' };
      const label = roundNames[r] || `Round ${r}`;
      const div = document.createElement('div');
      div.className = 'round-label';
      div.textContent = label;
      labelsEl.appendChild(div);
    }
  }

  // Scale & center after paint
  requestAnimationFrame(() => scaleBracket(totalW, totalH));
}

function scaleBracket(bracketW, bracketH) {
  const wrap = document.querySelector('.bracket-scroll-wrap');
  const container = $('bracket-container');
  if (!wrap || !container) return;

  const availW = wrap.clientWidth  - 32;
  const availH = window.innerHeight - 220; // header + labels + padding

  const scaleX = availW  / bracketW;
  const scaleY = availH  / bracketH;
  const scale  = Math.min(1, scaleX, scaleY); // never upscale

  container.style.transform       = `scale(${scale})`;
  container.style.transformOrigin = 'top left';

  // Collapse the wrapper to the scaled size so page doesn't over-scroll
  wrap.style.height = Math.ceil(bracketH * scale) + 'px';

  // Center horizontally if there's leftover space
  const scaledW = bracketW * scale;
  container.style.marginLeft = scaledW < availW ? Math.floor((availW - scaledW) / 2) + 'px' : '0';
}

function buildMatchupCard(m, pMap, isOwner, bracket) {
  const card = document.createElement('div');
  card.className = 'matchup-card';
  const isTbd = !m.participant_a_id || !m.participant_b_id;
  if (isTbd) card.classList.add('matchup-tbd');

  const pA = pMap[m.participant_a_id];
  const pB = pMap[m.participant_b_id];

  const totalVotesA = m.votes?.[m.participant_a_id] || 0;
  const totalVotesB = m.votes?.[m.participant_b_id] || 0;

  card.innerHTML = `
    ${buildSlot(m, pA, 'a', m.winner_id, totalVotesA, isOwner, bracket)}
    <div class="slot-divider"></div>
    ${buildSlot(m, pB, 'b', m.winner_id, totalVotesB, isOwner, bracket)}
  `;

  // Advance button click
  card.querySelectorAll('.slot-advance').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid = Number(btn.dataset.pid);
      const p = pMap[pid];
      openAdvanceModal(m.id, pid, p?.name || 'Unknown');
    });
  });

  // Rollback button click
  card.querySelectorAll('.slot-rollback').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const mid = Number(btn.dataset.mid);
      openRollbackModal(mid);
    });
  });

  return card;
}

function buildSlot(m, p, side, winnerId, votes, isOwner, bracket) {
  if (!p) {
    return `<div class="matchup-slot empty"><span class="slot-name tbd">TBD</span></div>`;
  }
  const isWinner = winnerId && m[`participant_${side}_id`] === winnerId;
  const isLoser  = winnerId && m[`participant_${side}_id`] !== winnerId;
  const cls = isWinner ? 'winner' : isLoser ? 'loser' : '';
  const img = p.img
    ? `<img class="slot-img" src="${esc(p.img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="slot-img-ph"></div>`;

  const seedStr  = state.display.seeds  ? `<span class="slot-seed">${p.seed}</span>` : '';
  const voteCount = votes > 0 ? votes : 0;
  const scoreVal  = side === 'a' ? m.score_a : m.score_b;
  const scoreStr  = state.display.scores && isOwner && bracket.status === 'active' && !winnerId
    ? `<input class="score-input" type="number" min="0" max="9999" value="${scoreVal ?? ''}" data-mid="${m.id}" data-side="${side}" placeholder="–">`
    : (state.display.scores && scoreVal !== null && scoreVal !== undefined)
      ? `<span class="slot-score">${scoreVal}</span>`
      : (state.display.scores && voteCount > 0 ? `<span class="slot-votes">${voteCount}</span>` : '');

  const canAdvance = isOwner && !winnerId && bracket.status === 'active' && m.participant_a_id && m.participant_b_id;
  const advanceBtn = canAdvance
    ? `<button class="slot-advance-btn slot-advance" data-pid="${p.id}" title="Advance ${esc(p.name)}">✓</button>`
    : '';
  const canRollback = isOwner && isWinner;
  const rollbackBtn = canRollback
    ? `<button class="slot-advance-btn slot-rollback" data-mid="${m.id}" title="Roll back this result">↩</button>`
    : '';

  return `
    <div class="matchup-slot ${cls}">
      ${seedStr}
      ${img}
      <span class="slot-name">${esc(p.name)}</span>
      ${scoreStr}
      ${advanceBtn}${rollbackBtn}
    </div>
  `;
}

function drawBracketLines(bracket, matchups, totalH, totalW) {
  const canvas = $('bracket-lines');
  canvas.width  = totalW;
  canvas.height = totalH;
  canvas.style.width  = totalW + 'px';
  canvas.style.height = totalH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, totalW, totalH);
  ctx.strokeStyle = '#323660';
  ctx.lineWidth = 1.5;

  const totalRounds = Math.log2(bracket.size);
  const byKey = {};
  matchups.forEach(m => { byKey[`${m.round}_${m.position}`] = m; });

  for (let r = 1; r < totalRounds; r++) {
    const roundMatchups = matchups.filter(m => m.round === r);
    for (const m of roundMatchups) {
      const pos      = calcMatchupPos(totalRounds, bracket.size, r, m.position);
      const nextPos  = Math.ceil(m.position / 2);
      const parent   = byKey[`${r + 1}_${nextPos}`];
      if (!parent) continue;
      const parentPos = calcMatchupPos(totalRounds, bracket.size, r + 1, parent.position);

      const startX = pos.x + CARD_W;
      const startY = pos.centerY;
      const endX   = parentPos.x;
      const endY   = parentPos.centerY;
      const midX   = startX + SPACER_W / 2;

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(midX, startY);
      ctx.lineTo(midX, endY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }
  }
}

function renderChampion(bracket, participants, matchups) {
  if (bracket.status !== 'complete') { hide('champion-display'); return; }
  const totalRounds = Math.log2(bracket.size);
  const final = matchups.find(m => m.round === totalRounds && m.winner_id);
  if (!final) { hide('champion-display'); return; }
  const champ = participants.find(p => p.id === final.winner_id);
  if (!champ) { hide('champion-display'); return; }
  $('champion-name').textContent = champ.name;
  show('champion-display');
}

// ─── Advance / Rollback Modal ─────────────────────────────────────────────────
let pendingAction = null; // { type: 'advance'|'rollback', matchup_id, winner_id?, winner_name? }

function openAdvanceModal(matchupId, winnerId, winnerName) {
  pendingAction = { type: 'advance', matchup_id: matchupId, winner_id: winnerId };
  $('advance-modal-title').textContent = 'Confirm Advancement';
  $('advance-confirm-text').textContent = `Advance "${winnerName}" as the winner of this matchup?`;
  $('advance-confirm-btn').textContent = 'Confirm Winner';
  $('advance-confirm-btn').className = 'btn btn-primary';
  show('advance-modal');
}

function openRollbackModal(matchupId) {
  pendingAction = { type: 'rollback', matchup_id: matchupId };
  $('advance-modal-title').textContent = 'Roll Back Result';
  $('advance-confirm-text').textContent = `This will undo the winner and any downstream results that depended on this matchup. Continue?`;
  $('advance-confirm-btn').textContent = 'Roll Back';
  $('advance-confirm-btn').className = 'btn btn-danger';
  show('advance-modal');
}

$('advance-modal-close').addEventListener('click', () => { hide('advance-modal'); pendingAction = null; });
$('advance-cancel-btn').addEventListener('click', () => { hide('advance-modal'); pendingAction = null; });

$('advance-confirm-btn').addEventListener('click', async () => {
  if (!pendingAction) return;
  const action = pendingAction;
  pendingAction = null;
  hide('advance-modal');

  try {
    if (action.type === 'advance') {
      await api('POST', `/api/brackets/${state.currentSlug}/advance`, { matchup_id: action.matchup_id, winner_id: action.winner_id });
    } else {
      await api('POST', `/api/brackets/${state.currentSlug}/rollback`, { matchup_id: action.matchup_id });
    }
    await refreshBracketView();
  } catch (e) {
    alert(`Failed to ${action.type}: ` + e.message);
  }
});

async function refreshBracketView() {
  const fresh = await api('GET', `/api/brackets/${state.currentSlug}`);
  state.bracketData = fresh;
  renderBracket(fresh.bracket, fresh.participants, fresh.matchups, fresh.isOwner);
  renderChampion(fresh.bracket, fresh.participants, fresh.matchups);
  const active = fresh.matchups.some(m => !m.winner_id && m.participant_a_id && m.participant_b_id);
  setHidden('vote-now-btn', fresh.bracket.status !== 'active' || !active);
}

// ─── Vote Modal ───────────────────────────────────────────────────────────────
$('vote-now-btn').addEventListener('click', openVoteModal);

function openVoteModal() {
  if (!state.bracketData) return;
  const { matchups, participants } = state.bracketData;
  const pMap = {};
  participants.forEach(p => { pMap[p.id] = p; });

  state.voteQueue = matchups.filter(m =>
    !m.winner_id && m.participant_a_id && m.participant_b_id
  );
  state.voteIndex = 0;

  if (!state.voteQueue.length) { alert('No active matchups to vote on right now.'); return; }
  showVoteMatchup(pMap);
  show('vote-modal');
}

function showVoteMatchup(pMap) {
  const m = state.voteQueue[state.voteIndex];
  if (!m) { hide('vote-modal'); return; }

  const pA = pMap[m.participant_a_id];
  const pB = pMap[m.participant_b_id];

  $('vote-progress').textContent = `${state.voteIndex + 1} of ${state.voteQueue.length} matchups`;
  $('vote-btn-a').textContent = `Vote for ${pA?.name || '?'}`;
  $('vote-btn-b').textContent = `Vote for ${pB?.name || '?'}`;
  $('vote-name-a').textContent = pA?.name || '?';
  $('vote-name-b').textContent = pB?.name || '?';

  // Images
  renderVoteImg($('vote-img-a'), pA);
  renderVoteImg($('vote-img-b'), pB);

  // Vote bars
  const totalVotes = (m.votes?.[m.participant_a_id] || 0) + (m.votes?.[m.participant_b_id] || 0);
  const pctA = totalVotes > 0 ? Math.round((m.votes?.[m.participant_a_id] || 0) / totalVotes * 100) : 50;
  const pctB = totalVotes > 0 ? Math.round((m.votes?.[m.participant_b_id] || 0) / totalVotes * 100) : 50;
  $('vote-bar-a').style.width = pctA + '%';
  $('vote-bar-b').style.width = pctB + '%';
  $('vote-pct-a').textContent = totalVotes > 0 ? pctA + '%' : '';
  $('vote-pct-b').textContent = totalVotes > 0 ? pctB + '%' : '';

  $('vote-side-a').classList.remove('voted-for');
  $('vote-side-b').classList.remove('voted-for');
  hide('vote-feedback');
  $('vote-btn-a').disabled = false;
  $('vote-btn-b').disabled = false;
}

function renderVoteImg(el, p) {
  el.innerHTML = '';
  if (p?.img) {
    const img = document.createElement('img');
    img.src = p.img;
    img.alt = p.name;
    img.onerror = () => { el.textContent = p?.name?.[0]?.toUpperCase() || '?'; };
    el.appendChild(img);
  } else {
    el.textContent = p?.name?.[0]?.toUpperCase() || '?';
  }
}

async function castVote(side) {
  const m = state.voteQueue[state.voteIndex];
  if (!m) return;
  const pid = side === 'a' ? m.participant_a_id : m.participant_b_id;

  $('vote-btn-a').disabled = true;
  $('vote-btn-b').disabled = true;

  const sideEl = side === 'a' ? $('vote-side-a') : $('vote-side-b');
  sideEl.classList.add('voted-for');

  try {
    await api('POST', `/api/brackets/${state.currentSlug}/vote`, {
      matchup_id: m.id,
      participant_id: pid,
    });
    $('vote-feedback').textContent = 'Vote cast!';
    show('vote-feedback');
  } catch (e) {
    const msg = e.status === 409 ? 'You already voted in this matchup.' : e.message;
    $('vote-feedback').textContent = msg;
    $('vote-feedback').style.color = 'var(--danger)';
    show('vote-feedback');
  }

  setTimeout(() => {
    $('vote-feedback').style.color = '';
    state.voteIndex++;
    const { participants } = state.bracketData;
    const pMap = {};
    participants.forEach(p => { pMap[p.id] = p; });
    if (state.voteIndex < state.voteQueue.length) {
      showVoteMatchup(pMap);
    } else {
      hide('vote-modal');
    }
  }, 900);
}

$('vote-btn-a').addEventListener('click', () => castVote('a'));
$('vote-btn-b').addEventListener('click', () => castVote('b'));
$('vote-skip-btn').addEventListener('click', () => {
  const { participants } = state.bracketData;
  const pMap = {};
  participants.forEach(p => { pMap[p.id] = p; });
  state.voteIndex++;
  if (state.voteIndex < state.voteQueue.length) showVoteMatchup(pMap);
  else hide('vote-modal');
});
$('vote-modal-close').addEventListener('click', () => hide('vote-modal'));

// Close modals on overlay click
['create-modal', 'vote-modal', 'advance-modal', 'bulk-modal', 'export-modal'].forEach(id => {
  $(id).addEventListener('click', e => {
    if (e.target === $(id)) $(id).classList.add('hidden');
  });
});

// ─── Stripe Checkout ──────────────────────────────────────────────────────────
async function startCheckout() {
  if (!state.user) { showAuth(); return; }
  try {
    const { url } = await api('POST', '/api/checkout');
    window.location.href = url;
  } catch (e) {
    alert('Checkout unavailable: ' + e.message);
  }
}

// ─── Escape HTML ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Print / PDF ──────────────────────────────────────────────────────────────
// (triggered by export modal when PDF is selected)

function printBracket() {
  if (!state.bracketData) return;
  const { bracket } = state.bracketData;
  const totalRounds = Math.log2(bracket.size);
  const totalH = bracket.size * (CARD_H / 2) + V_PAD * 2;
  const totalW = totalRounds * ROUND_GAP;

  const container = $('bracket-container');
  const wrap      = document.querySelector('.bracket-scroll-wrap');

  // Snapshot current styles
  const prevTransform   = container.style.transform;
  const prevMarginLeft  = container.style.marginLeft;
  const prevWrapHeight  = wrap.style.height;

  // Calculate a zoom level so the bracket fills ~90% of the landscape printable area
  // Standard landscape printable area ≈ 257mm × 170mm at 96dpi ≈ 975 × 644px
  const PRINT_W = 975;
  const PRINT_H = 644;
  const printZoom = Math.min(1, PRINT_W / totalW, PRINT_H / totalH).toFixed(3);

  // Pass zoom to CSS and inject bracket title for the ::before pseudo
  const bracketMain = document.querySelector('.bracket-main');
  bracketMain.dataset.title  = bracket.title;
  bracketMain.style.setProperty('--print-zoom', printZoom);

  // Strip runtime scaling — print CSS takes over
  container.style.transform  = 'none';
  container.style.marginLeft = '0';
  wrap.style.height          = totalH + 'px';

  // Redraw canvas at full native resolution (no devicePixelRatio tricks needed)
  drawBracketLines(bracket, state.bracketData.matchups, totalH, totalW);

  // Set print title to bracket name
  const prevTitle = document.title;
  document.title  = bracket.title;

  window.print();

  // Restore after print dialog closes (synchronous in all browsers)
  document.title             = prevTitle;
  container.style.transform  = prevTransform;
  container.style.marginLeft = prevMarginLeft;
  wrap.style.height          = prevWrapHeight;
  bracketMain.style.removeProperty('--print-zoom');

  // Redraw canvas back at screen scale
  requestAnimationFrame(() => scaleBracket(totalW, totalH));
}

// ─── Bracket Toolbar — toggles ────────────────────────────────────────────────
function initToolbar(isOwner) {
  const toolbar = $('bracket-toolbar');
  setHidden('bracket-toolbar', !isOwner && false); // always show toolbar on bracket view
  toolbar.classList.remove('hidden');

  // Sync checkboxes to state
  $('toggle-seeds').checked       = state.display.seeds;
  $('toggle-scores').checked      = state.display.scores;
  $('toggle-round-titles').checked = state.display.roundTitles;

  $('toggle-seeds').onchange = () => {
    state.display.seeds = $('toggle-seeds').checked;
    saveDisplay();
    rerenderBracket();
  };
  $('toggle-scores').onchange = () => {
    state.display.scores = $('toggle-scores').checked;
    saveDisplay();
    rerenderBracket();
  };
  $('toggle-round-titles').onchange = () => {
    state.display.roundTitles = $('toggle-round-titles').checked;
    saveDisplay();
    rerenderBracket();
  };
}

function rerenderBracket() {
  if (!state.bracketData) return;
  const { bracket, participants, matchups, isOwner } = state.bracketData;
  renderBracket(bracket, participants, matchups, isOwner);
}

// ─── Zoom Controls ────────────────────────────────────────────────────────────
function updateZoomLabel() {
  $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
}

$('zoom-in-btn').addEventListener('click', () => {
  state.zoom = Math.min(2, +(state.zoom + 0.1).toFixed(1));
  applyManualZoom();
});
$('zoom-out-btn').addEventListener('click', () => {
  state.zoom = Math.max(0.2, +(state.zoom - 0.1).toFixed(1));
  applyManualZoom();
});
$('zoom-fit-btn').addEventListener('click', () => {
  if (!state.bracketData) return;
  const { bracket } = state.bracketData;
  const totalRounds = Math.log2(bracket.size);
  const totalH = bracket.size * (CARD_H / 2) + V_PAD * 2;
  const totalW = totalRounds * ROUND_GAP;
  // Compute fit scale and set it
  const availW = document.querySelector('.bracket-scroll-wrap').clientWidth - 32;
  const availH = window.innerHeight - 220;
  state.zoom = Math.min(1, availW / totalW, availH / totalH);
  applyManualZoom();
});

function applyManualZoom() {
  const container = $('bracket-container');
  const wrap      = document.querySelector('.bracket-scroll-wrap');
  if (!container || !state.bracketData) return;
  const { bracket } = state.bracketData;
  const totalRounds = Math.log2(bracket.size);
  const totalH = bracket.size * (CARD_H / 2) + V_PAD * 2;
  container.style.transform  = `scale(${state.zoom})`;
  container.style.transformOrigin = 'top left';
  container.style.marginLeft = '0';
  wrap.style.height = Math.ceil(totalH * state.zoom) + 'px';
  updateZoomLabel();
}

// ─── Inline Title Editing ─────────────────────────────────────────────────────
$('bracket-title').addEventListener('click', function() {
  if (!state.bracketData?.isOwner) return;
  const current = this.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'bracket-title-input';
  input.maxLength = 80;
  this.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newTitle = input.value.trim() || current;
    const span = document.createElement('span');
    span.id = 'bracket-title';
    span.className = 'bracket-title-editable';
    span.title = 'Click to edit';
    span.textContent = newTitle;
    input.replaceWith(span);
    attachTitleEdit();
    if (newTitle !== current) {
      try {
        await api('PATCH', `/api/brackets/${state.currentSlug}`, { title: newTitle });
        state.bracketData.bracket.title = newTitle;
        document.title = newTitle;
      } catch {}
    }
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } });
});

function attachTitleEdit() {
  const el = $('bracket-title');
  if (el && state.bracketData?.isOwner) el.style.cursor = 'pointer';
}

// ─── Score Entry ──────────────────────────────────────────────────────────────
// Scores are rendered inside matchup cards; owner can type and blur to save
function handleScoreInput(e) {
  const input = e.target;
  if (!input.classList.contains('score-input')) return;
  const { mid, side } = input.dataset;
  const val = input.value === '' ? null : Number(input.value);
  const body = side === 'a' ? { score_a: val } : { score_b: val };
  api('PATCH', `/api/brackets/${state.currentSlug}/matchups/${mid}`, body).then(() => {
    // Update local state
    const m = state.bracketData.matchups.find(x => x.id === Number(mid));
    if (m) { if (side === 'a') m.score_a = val; else m.score_b = val; }
    // Re-render just the score display (no full re-render to avoid losing focus)
  }).catch(() => {});
}

$('bracket-rounds').addEventListener('change', handleScoreInput);

// ─── Export Modal ─────────────────────────────────────────────────────────────
$('export-btn').addEventListener('click', () => {
  if (!state.bracketData) return;
  const slug = state.bracketData.bracket.slug;
  $('export-filename').value = slug + '.pdf';
  show('export-modal');
});
$('export-modal-close').addEventListener('click', () => hide('export-modal'));
$('export-cancel-btn').addEventListener('click', () => hide('export-modal'));

$('export-options').addEventListener('click', e => {
  const opt = e.target.closest('.export-option');
  if (!opt) return;
  document.querySelectorAll('.export-option').forEach(o => o.classList.remove('selected'));
  opt.classList.add('selected');
  opt.querySelector('input').checked = true;
  const fmt = opt.dataset.fmt;
  $('export-filename').value = ($('export-filename').value || 'bracket').replace(/\.\w+$/, '') + '.' + fmt;
  setHidden('pdf-settings', fmt !== 'pdf');
});

$('export-confirm-btn').addEventListener('click', async () => {
  const fmt = document.querySelector('.export-option.selected')?.dataset.fmt || 'pdf';
  hide('export-modal');
  if (fmt === 'pdf') {
    printBracket();
  } else {
    await exportImage(fmt);
  }
});

async function exportImage(fmt) {
  if (typeof html2canvas === 'undefined') { alert('Image export not available (html2canvas failed to load).'); return; }
  const { bracket } = state.bracketData;
  const totalRounds = Math.log2(bracket.size);
  const totalH = bracket.size * (CARD_H / 2) + V_PAD * 2;
  const totalW = totalRounds * ROUND_GAP;
  const container  = $('bracket-container');
  const wrap       = document.querySelector('.bracket-scroll-wrap');

  // Temporarily remove scale for capture
  const prevTransform = container.style.transform;
  const prevMarginLeft = container.style.marginLeft;
  const prevHeight = wrap.style.height;
  container.style.transform  = 'none';
  container.style.marginLeft = '0';
  wrap.style.height = totalH + 'px';
  drawBracketLines(bracket, state.bracketData.matchups, totalH, totalW);

  try {
    const canvas = await html2canvas(container, {
      backgroundColor: '#0D0F1A',
      scale: 2,
      useCORS: true,
      logging: false,
      width: totalW,
      height: totalH,
    });
    const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
    const filename = ($('export-filename').value || 'bracket') + '';
    const a = document.createElement('a');
    a.href = canvas.toDataURL(mime, 0.95);
    a.download = filename.endsWith('.' + fmt) ? filename : filename + '.' + fmt;
    a.click();
  } catch (e) {
    alert('Export failed: ' + e.message);
  } finally {
    container.style.transform  = prevTransform;
    container.style.marginLeft = prevMarginLeft;
    wrap.style.height          = prevHeight;
    requestAnimationFrame(() => {
      const { bracket } = state.bracketData;
      const totalRounds = Math.log2(bracket.size);
      const totalH = bracket.size * (CARD_H / 2) + V_PAD * 2;
      const totalW = totalRounds * ROUND_GAP;
      scaleBracket(totalW, totalH);
    });
  }
}

// Re-scale on resize
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (state.bracketData) {
      const { bracket } = state.bracketData;
      const totalRounds = Math.log2(bracket.size);
      const totalH = bracket.size * (CARD_H / 2) + V_PAD * 2;
      const totalW = totalRounds * ROUND_GAP;
      scaleBracket(totalW, totalH);
    }
  }, 120);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadAuth();
checkUrlParams();
route(window.location.pathname);
