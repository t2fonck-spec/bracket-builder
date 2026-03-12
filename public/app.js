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
  panX: 0,
  panY: 0,
  championDismissed: false,
  pendingBracket: null,
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
const VIEWS = ['auth-view', 'dashboard-view', 'manage-view', 'bracket-view', 'landing-view', 'reset-password-view'];
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

  // Reset password route
  if (slug === 'reset-password') {
    showView('reset-password');
    return;
  }

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
async function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('upgraded') === '1') {
    // Re-fetch user to get updated tier
    try {
      const user = await api('GET', '/api/me');
      saveAuth(state.token, user);
      renderHeaderTier();
    } catch (_) {}
    window.history.replaceState({}, '', '/');
  }
  if (params.get('payment') === 'success') {
    const sessionId = params.get('session_id');
    if (sessionId) {
      // Verify payment server-side to unlock bracket immediately (avoid webhook race)
      try { await api('POST', '/api/verify-payment', { session_id: sessionId }); } catch (_) {}
    }
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);
  }
  if (params.get('cancelled') === '1' || params.get('payment') === 'cancelled') {
    window.history.replaceState({}, '', '/');
  }
}

// ─── Auth View ────────────────────────────────────────────────────────────────
function showAuth() {
  if (!state.user) {
    showView('landing');
  } else {
    showView('auth');
  }
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

// Forgot password
$('forgot-password-link').addEventListener('click', e => {
  e.preventDefault();
  show('forgot-password-form');
});

$('forgot-submit').addEventListener('click', async () => {
  hide('forgot-error'); hide('forgot-msg');
  const email = $('forgot-email').value.trim();
  if (!email) return;
  try {
    await api('POST', '/api/forgot-password', { email });
    show('forgot-msg');
  } catch (e) {
    $('forgot-error').textContent = e.message;
    show('forgot-error');
  }
});

// Reset password (from email link — token is in URL query param: /reset-password?token=xxx)
$('reset-submit').addEventListener('click', async () => {
  hide('reset-error'); hide('reset-msg');
  const password = $('reset-new-password').value;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) { $('reset-error').textContent = 'Invalid reset link'; show('reset-error'); return; }
  try {
    await api('POST', '/api/reset-password', { token, password });
    $('reset-msg').textContent = 'Password reset! You can now sign in.';
    show('reset-msg');
  } catch (e) {
    $('reset-error').textContent = e.message;
    show('reset-error');
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

  // Check if NCAA template is available
  try {
    const ncaa = await api('GET', '/api/ncaa-template');
    setHidden('ncaa-template-btn', !ncaa.available);
  } catch { setHidden('ncaa-template-btn', true); }
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

$('upgrade-btn')?.addEventListener('click', async () => {
  try {
    const data = await api('POST', '/api/checkout/lifetime');
    if (data.url) window.location.href = data.url;
  } catch (e) {
    alert('Checkout failed: ' + e.message);
  }
});

// ─── NCAA Template Button ─────────────────────────────────────────────────────
$('ncaa-template-btn').addEventListener('click', async () => {
  try {
    const data = await api('POST', '/api/brackets/ncaa');
    if (data.requiresPayment && data.checkoutUrl) {
      // Show payment modal with per-bracket vs lifetime choice
      state.pendingBracket = { ...data, size: 64 };
      $('payment-size').textContent = '64';
      $('payment-per-price').textContent = '$2.99';
      show('payment-modal');
    } else {
      navigate('/' + data.slug);
    }
  } catch (e) {
    alert('Failed: ' + e.message);
  }
});

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
$('size-upgrade-link')?.addEventListener('click', e => { e.preventDefault(); closeCreateModal(); show('payment-modal'); });

$('create-form').addEventListener('submit', async e => {
  e.preventDefault();
  hide('create-error');
  const title = $('b-title').value.trim();
  const size = Number(document.querySelector('.size-option.selected')?.dataset.size || 8);
  if (!title) return;
  try {
    const data = await api('POST', '/api/brackets', { title, size });
    // If server returns checkoutUrl, bracket is pending_payment — show payment modal
    if (data.checkoutUrl) {
      state.pendingBracket = data;
      const priceMap = { 16: '$0.99', 32: '$1.99', 64: '$2.99' };
      $('payment-size').textContent = data.size;
      $('payment-per-price').textContent = priceMap[data.size] || '$2.99';
      closeCreateModal();
      show('payment-modal');
      return;
    }
    closeCreateModal();
    await showManageView(data.slug);
  } catch (err) {
    $('create-error').textContent = err.message;
    show('create-error');
  }
});

$('pay-per-bracket-btn').addEventListener('click', () => {
  if (state.pendingBracket?.checkoutUrl) {
    window.location.href = state.pendingBracket.checkoutUrl;
  }
});

$('pay-lifetime-btn').addEventListener('click', async () => {
  try {
    const data = await api('POST', '/api/checkout/lifetime');
    if (data.url) window.location.href = data.url;
  } catch (e) {
    alert('Checkout failed: ' + e.message);
  }
});

$('payment-cancel-btn').addEventListener('click', () => {
  hide('payment-modal');
  state.pendingBracket = null;
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
  // Use uploaded URL first, then fall back to pasted URL
  const img = $('p-img-url').value.trim() || $('p-img').value.trim();
  if (!name) return;
  try {
    await api('POST', `/api/brackets/${state.managingSlug}/participants`, { name, img: img || null });
    $('p-name').value = '';
    $('p-img').value = '';
    $('p-img-url').value = '';
    $('p-img-file').value = '';
    $('p-img-preview').classList.add('hidden');
    $('p-name').focus();
    await refreshManageView();
  } catch (e) {
    $('add-p-error').textContent = e.message;
    show('add-p-error');
  }
});

// ─── Image Upload for participants ────────────────────────────────────────────
$('upload-img-btn').addEventListener('click', () => {
  $('p-img-file').click();
});

$('p-img-file').addEventListener('change', async () => {
  const file = $('p-img-file').files[0];
  if (!file) return;
  hide('add-p-error');

  // 5MB guard
  if (file.size > 5 * 1024 * 1024) {
    $('add-p-error').textContent = 'Image must be under 5MB.';
    show('add-p-error');
    $('p-img-file').value = '';
    return;
  }

  const addBtn = $('add-p-btn');
  const uploadBtn = $('upload-img-btn');
  addBtn.disabled = true;
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading…';

  try {
    const fd = new FormData();
    fd.append('image', file);
    const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token }, body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

    $('p-img-url').value = data.url;
    $('p-img').value = '';

    // Show preview
    const preview = $('p-img-preview');
    preview.src = data.url;
    preview.classList.remove('hidden');
  } catch (err) {
    $('add-p-error').textContent = 'Upload failed: ' + err.message;
    show('add-p-error');
    $('p-img-file').value = '';
  } finally {
    addBtn.disabled = false;
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload Image';
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
  state.zoom = 1; state.panX = 0; state.panY = 0;
  state.championDismissed = false;
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
        const statusClass = { setup: 'badge-setup', active: 'badge-active', complete: 'badge-complete' }[fresh.bracket.status] || '';
        $('bracket-status-badge').className = `badge ${statusClass}`;
        $('bracket-status-badge').textContent = fresh.bracket.status;
        const active = fresh.matchups.some(m => !m.winner_id && m.participant_a_id && m.participant_b_id);
        setHidden('vote-now-btn', fresh.bracket.status !== 'active' || !active);
        if (fresh.bracket.status !== 'active') { clearInterval(state.pollTimer); state.pollTimer = null; }
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
const LABEL_H   = 24; // height reserved at top for column labels

// Returns layout metrics for a two-sided bracket
function calcTwosidedLayout(bracket) {
  const totalRounds = Math.log2(bracket.size);
  const sideRounds  = totalRounds - 1;
  // Each side has size/2 participants stacked; height mirrors a single-sided half-bracket
  const totalH = (bracket.size / 2) * (CARD_H / 2) + V_PAD * 2;
  let totalW, FINAL_X;
  if (sideRounds <= 0) {
    // 2-team bracket: just a final, no side rounds
    FINAL_X = 0;
    totalW  = CARD_W;
  } else {
    // Gap from innermost side round's right/left edge to the final card
    FINAL_X = (sideRounds - 1) * ROUND_GAP + CARD_W + SPACER_W;
    totalW  = 2 * FINAL_X + CARD_W;
  }
  return { totalRounds, sideRounds, totalH, totalW, FINAL_X };
}

// Returns { x, y, centerY, side } for a matchup card in two-sided layout
function getMatchupPos(m, bracket, layout) {
  const { totalRounds, totalH, totalW, FINAL_X } = layout;
  const r           = m.round;
  const numMatchups  = bracket.size / Math.pow(2, r);
  const halfMatchups = numMatchups / 2;

  if (r === totalRounds) {
    // Final: center horizontally, center vertically
    const y = (totalH - CARD_H) / 2 + LABEL_H;
    return { x: FINAL_X, y, centerY: totalH / 2 + LABEL_H, side: 'final' };
  }

  const isLeft   = m.position <= halfMatchups;
  const localPos = isLeft ? m.position : m.position - halfMatchups;
  const slotH    = (totalH - V_PAD * 2) / halfMatchups;
  const y        = LABEL_H + V_PAD + slotH * (localPos - 1) + (slotH - CARD_H) / 2;
  const centerY  = LABEL_H + V_PAD + slotH * (localPos - 1) + slotH / 2;
  const x        = isLeft
    ? (r - 1) * ROUND_GAP
    : totalW - (r - 1) * ROUND_GAP - CARD_W;

  return { x, y, centerY, side: isLeft ? 'left' : 'right' };
}

function renderBracket(bracket, participants, matchups, isOwner) {
  const rounds = $('bracket-rounds');
  rounds.innerHTML = '';

  const layout = calcTwosidedLayout(bracket);
  const { totalRounds, totalH, totalW } = layout;
  const containerH = totalH + LABEL_H;

  rounds.style.height = containerH + 'px';
  rounds.style.width  = totalW + 'px';

  const pMap = {};
  participants.forEach(p => { pMap[p.id] = p; });

  for (const m of matchups) {
    const pos  = getMatchupPos(m, bracket, layout);
    const card = buildMatchupCard(m, pMap, isOwner, bracket);
    card.style.top  = pos.y + 'px';
    card.style.left = pos.x + 'px';
    rounds.appendChild(card);
  }

  // Inline round labels (inside bracket-container so they pan/zoom with bracket)
  renderRoundLabels(bracket, layout, totalW);

  drawBracketLines(bracket, matchups, containerH, totalW, layout);
  requestAnimationFrame(() => scaleBracket(totalW, containerH));
}

function renderRoundLabels(bracket, layout, totalW) {
  // Remove previous label layer
  const old = $('bracket-col-labels');
  if (old) old.remove();
  // Keep external labels hidden (replaced by inline ones)
  setHidden('bracket-round-labels', true);
  if (!state.display.roundTitles) return;

  const { totalRounds, sideRounds, FINAL_X } = layout;
  const el = document.createElement('div');
  el.id = 'bracket-col-labels';
  $('bracket-container').appendChild(el);

  let nameMap;
  if (bracket.size === 64) {
    nameMap = {
      1: 'Round of 64', 2: 'Round of 32', 3: 'Sweet 16',
      4: 'Elite Eight', 5: 'Final Four', 6: 'Championship'
    };
  } else {
    nameMap = {
      [totalRounds]:     'Final',
      [totalRounds - 1]: 'Semis',
      [totalRounds - 2]: 'Quarters',
    };
  }

  for (let r = 1; r <= totalRounds; r++) {
    const name = nameMap[r] || `Round ${r}`;
    if (r === totalRounds) {
      addColLabel(el, name, FINAL_X, CARD_W);
    } else {
      addColLabel(el, name, (r - 1) * ROUND_GAP, CARD_W);
      addColLabel(el, name, totalW - (r - 1) * ROUND_GAP - CARD_W, CARD_W);
    }
  }
}

function addColLabel(container, text, x, width) {
  const div = document.createElement('div');
  div.className = 'bracket-col-label';
  div.style.left  = x + 'px';
  div.style.width = width + 'px';
  div.textContent = text;
  container.appendChild(div);
}

function scaleBracket(bracketW, bracketH) {
  const wrap = document.querySelector('.bracket-scroll-wrap');
  const container = $('bracket-container');
  if (!wrap || !container) return;

  const availW = wrap.clientWidth;
  const availH = wrap.clientHeight;

  const scale = Math.min(1, availW / bracketW, availH / bracketH);

  state.zoom = scale;
  state.panX = Math.floor((availW - bracketW * scale) / 2);
  state.panY = Math.floor((availH - bracketH * scale) / 2);
  if (state.panY < 0) state.panY = V_PAD;

  applyTransform();
  updateZoomLabel();
}

function applyTransform() {
  const container = $('bracket-container');
  if (!container) return;
  container.style.transform       = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  container.style.transformOrigin = '0 0';
  container.style.marginLeft      = '0';
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

function drawBracketLines(bracket, matchups, totalH, totalW, layout) {
  if (!layout) layout = calcTwosidedLayout(bracket);
  const canvas = $('bracket-lines');
  canvas.width  = totalW;
  canvas.height = totalH;
  canvas.style.width  = totalW + 'px';
  canvas.style.height = totalH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, totalW, totalH);
  ctx.strokeStyle = '#323660';
  ctx.lineWidth = 1.5;

  const { totalRounds } = layout;
  const byKey = {};
  matchups.forEach(m => { byKey[`${m.round}_${m.position}`] = m; });

  for (let r = 1; r < totalRounds; r++) {
    const roundMatchups = matchups.filter(m => m.round === r);
    for (const m of roundMatchups) {
      const pos    = getMatchupPos(m, bracket, layout);
      const parent = byKey[`${r + 1}_${Math.ceil(m.position / 2)}`];
      if (!parent) continue;
      const ppos = getMatchupPos(parent, bracket, layout);

      ctx.beginPath();
      if (pos.side === 'left') {
        // Right edge of card → left edge of parent (going right / inward)
        const startX = pos.x + CARD_W;
        const endX   = ppos.x;
        const midX   = (startX + endX) / 2;
        ctx.moveTo(startX, pos.centerY);
        ctx.lineTo(midX, pos.centerY);
        ctx.lineTo(midX, ppos.centerY);
        ctx.lineTo(endX, ppos.centerY);
      } else {
        // Left edge of card → right edge of parent (going left / inward)
        const startX = pos.x;
        const endX   = ppos.x + CARD_W;
        const midX   = (startX + endX) / 2;
        ctx.moveTo(startX, pos.centerY);
        ctx.lineTo(midX, pos.centerY);
        ctx.lineTo(midX, ppos.centerY);
        ctx.lineTo(endX, ppos.centerY);
      }
      ctx.stroke();
    }
  }
}

function renderChampion(bracket, participants, matchups) {
  if (bracket.status !== 'complete') { hide('champion-modal'); return; }
  if (state.championDismissed) return;
  const totalRounds = Math.log2(bracket.size);
  const final = matchups.find(m => m.round === totalRounds && m.winner_id);
  if (!final) { hide('champion-modal'); return; }
  const champ = participants.find(p => p.id === final.winner_id);
  if (!champ) { hide('champion-modal'); return; }
  $('champion-name').textContent = champ.name;
  if (champ.img) {
    $('champion-img').src = champ.img;
    $('champion-img').classList.remove('hidden');
  } else {
    $('champion-img').classList.add('hidden');
  }
  show('champion-modal');
}

$('champion-close').addEventListener('click', () => { state.championDismissed = true; hide('champion-modal'); });
$('champion-modal').addEventListener('click', e => {
  if (e.target === $('champion-modal')) { state.championDismissed = true; hide('champion-modal'); }
});

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
  // Update status badge
  const statusClass = { setup: 'badge-setup', active: 'badge-active', complete: 'badge-complete' }[fresh.bracket.status] || '';
  $('bracket-status-badge').className = `badge ${statusClass}`;
  $('bracket-status-badge').textContent = fresh.bracket.status;
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
['create-modal', 'vote-modal', 'advance-modal', 'bulk-modal', 'export-modal', 'payment-modal'].forEach(id => {
  $(id).addEventListener('click', e => {
    if (e.target === $(id)) $(id).classList.add('hidden');
  });
});

// ─── Stripe Checkout ──────────────────────────────────────────────────────────
// startCheckout replaced by inline handlers for per-bracket and lifetime options

// ─── Escape HTML ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Print / PDF ──────────────────────────────────────────────────────────────
// (triggered by export modal when PDF is selected)

function printBracket() {
  if (!state.bracketData) return;
  const { bracket } = state.bracketData;
  const { totalW, totalH: _totalH } = calcTwosidedLayout(bracket);
  const totalH = _totalH + LABEL_H;

  const container = $('bracket-container');
  const wrap      = document.querySelector('.bracket-scroll-wrap');

  // Snapshot current styles
  const prevTransform   = container.style.transform;
  const prevMarginLeft  = container.style.marginLeft;

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
  bracketMain.style.removeProperty('--print-zoom');

  // Redraw canvas back at screen scale
  requestAnimationFrame(() => scaleBracket(totalW, totalH));
}

// ─── Bracket Settings — toggles ───────────────────────────────────────────────
function initToolbar(isOwner) {
  // Sync checkboxes to state
  $('toggle-seeds').checked        = state.display.seeds;
  $('toggle-scores').checked       = state.display.scores;
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

// Zoom toward the center of the viewport
function zoomToCenter(factor) {
  const wrap = document.querySelector('.bracket-scroll-wrap');
  if (!wrap) return;
  const cx = wrap.clientWidth  / 2;
  const cy = wrap.clientHeight / 2;
  applyZoomToPoint(cx, cy, factor);
}

function applyZoomToPoint(mx, my, factor) {
  const newZoom = Math.max(0.1, Math.min(4, state.zoom * factor));
  const contentX = (mx - state.panX) / state.zoom;
  const contentY = (my - state.panY) / state.zoom;
  state.panX  = mx - contentX * newZoom;
  state.panY  = my - contentY * newZoom;
  state.zoom  = newZoom;
  applyTransform();
  updateZoomLabel();
}

$('zoom-in-btn').addEventListener('click', () => zoomToCenter(1.25));
$('zoom-out-btn').addEventListener('click', () => zoomToCenter(1 / 1.25));
$('zoom-fit-btn').addEventListener('click', () => {
  if (!state.bracketData) return;
  const { bracket } = state.bracketData;
  const { totalW, totalH } = calcTwosidedLayout(bracket);
  scaleBracket(totalW, totalH + LABEL_H);
});

// ─── Wheel Zoom to Cursor ─────────────────────────────────────────────────────
(function() {
  const wrap = document.querySelector('.bracket-scroll-wrap');
  if (!wrap) return;

  wrap.addEventListener('wheel', e => {
    if (!state.bracketData) return;
    e.preventDefault();
    const rect   = wrap.getBoundingClientRect();
    const mx     = e.clientX - rect.left;
    const my     = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    applyZoomToPoint(mx, my, factor);
  }, { passive: false });
})();

// ─── Drag to Pan ──────────────────────────────────────────────────────────────
(function() {
  const wrap = document.querySelector('.bracket-scroll-wrap');
  if (!wrap) return;
  let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;

  wrap.addEventListener('mousedown', e => {
    // Only drag on background (not on interactive cards), or middle-click anywhere
    if (e.button === 1 || (e.button === 0 && e.target.closest('.bracket-container') && !e.target.closest('.matchup-card'))) {
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startPanX = state.panX; startPanY = state.panY;
      wrap.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    state.panX = startPanX + (e.clientX - startX);
    state.panY = startPanY + (e.clientY - startY);
    applyTransform();
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; wrap.style.cursor = ''; }
  });
})();

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
  const { totalW, totalH: _totalH } = calcTwosidedLayout(bracket);
  const totalH = _totalH + LABEL_H;
  const container  = $('bracket-container');

  // Temporarily remove scale for capture
  const prevTransform  = container.style.transform;
  const prevMarginLeft = container.style.marginLeft;
  container.style.transform  = 'none';
  container.style.marginLeft = '0';
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
    drawBracketLines(bracket, state.bracketData.matchups, totalH, totalW);
  }
}

// Re-scale on resize
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (state.bracketData) {
      const { bracket } = state.bracketData;
      const { totalW, totalH } = calcTwosidedLayout(bracket);
      scaleBracket(totalW, totalH + LABEL_H);
    }
  }, 120);
});

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
  // Update all theme toggle buttons
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.textContent = theme === 'light' ? '☀' : '☾';
  });
}

// Load saved theme on boot
(function() {
  const saved = localStorage.getItem('bb_theme');
  if (saved === 'light') document.documentElement.dataset.theme = 'light';
})();

// Event delegation for theme toggle buttons
document.addEventListener('click', e => {
  if (!e.target.classList.contains('theme-toggle-btn')) return;
  const isLight = document.documentElement.dataset.theme === 'light';
  const next = isLight ? 'dark' : 'light';
  localStorage.setItem('bb_theme', next);
  applyTheme(next);
});

// Apply theme icons on initial load
(function() {
  const saved = localStorage.getItem('bb_theme') || 'dark';
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.textContent = saved === 'light' ? '☀' : '☾';
  });
})();

// ─── Settings Popover ─────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const popover = $('settings-popover');
  const settingsBtn = $('settings-btn');
  if (!popover) return;
  if (e.target === settingsBtn || settingsBtn?.contains(e.target)) {
    popover.classList.toggle('hidden');
    return;
  }
  if (!popover.classList.contains('hidden') && !popover.contains(e.target)) {
    popover.classList.add('hidden');
  }
});

// ─── Landing Page ─────────────────────────────────────────────────────────────
$('landing-signup-btn')?.addEventListener('click', () => {
  hide('landing-view');
  show('auth-view');
  document.querySelector('.auth-tab[data-tab="register"]')?.click();
});

$('pricing-free-btn')?.addEventListener('click', () => {
  hide('landing-view');
  show('auth-view');
});

$('pricing-perbracket-btn')?.addEventListener('click', () => {
  hide('landing-view');
  show('auth-view');
});

$('pricing-lifetime-btn')?.addEventListener('click', async () => {
  if (!state.user) {
    hide('landing-view');
    show('auth-view');
    return;
  }
  try {
    const data = await api('POST', '/api/checkout/lifetime');
    if (data.url) window.location.href = data.url;
  } catch (e) {
    alert('Checkout failed: ' + e.message);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadAuth();
checkUrlParams().then(() => route(window.location.pathname));
