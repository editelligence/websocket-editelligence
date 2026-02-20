'use strict';
// ─── CONSTANTS & SECURITY ───
const SEC = {
  MAX_FILE_SIZE: 5 * 1024 * 1024, MAX_FILES: 20, MAX_CHAT_LEN: 500, MAX_NAME_LEN: 20, MAX_FILENAME_LEN: 80, RATE_LIMIT_PER_SEC: 120,
  ALLOWED_TYPES: new Set(['sync', 'patch', 'cursor', 'file-open', 'file-list', 'file-delete', 'file-rename', 'permission-change', 'kick', 'chat', 'peer-info', 'request-workspace', 'workspace-data', 'settings-update', 'ack', 'canvas-draw', 'canvas-state', 'canvas-cursor', 'slide-update', 'dot-update'])
};
const LANG_MAP = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css', json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', sql: 'sql', xml: 'xml', vue: 'html', svelte: 'html', toml: 'ini', ini: 'ini', env: 'plaintext', txt: 'plaintext', log: 'plaintext' };
const LANG_COLORS = { javascript: '#f7df1e', typescript: '#3178c6', html: '#e34c26', css: '#264de4', python: '#3572A5', json: '#cbcb41', markdown: '#083fa1', go: '#00ADD8', rust: '#dea584', java: '#b07219', cpp: '#f34b7d', ruby: '#701516', sql: '#e38c00', bash: '#4EAA25', plaintext: '#6e7681' };
const PEER_COLORS = ['#ff6b6b', '#ff9f43', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#5f27cd', '#1dd1a1', '#c8d6e5', '#ee5a24'];
function getLang(f) { return LANG_MAP[f.split('.').pop().toLowerCase()] || 'plaintext' }
function getLangColor(l) { return LANG_COLORS[l] || '#6e7681' }

// ─── STATE ───
const state = {
  peer: null, conns: {}, role: null, roomCode: null, myId: null, myName: 'Anonymous', myColor: PEER_COLORS[0],
  peers: {}, workspace: {}, activeFile: null, editor: null, decorations: {}, rateLimits: {},
  settings: { downloadAllowed: true, defaultRole: 'editor' }, chat: [], syncDebounce: null, cursorDebounce: null,
  suppressChange: false, localVersion: {}, rightPanelOpen: true, contextTarget: null, monacoReady: false,
  currentView: 'editor',
  // Canvas state
  canvas: {
    tool: 'select', color: '#a78bfa', strokeWidth: 3, elements: [], undoStack: [], redoStack: [],
    isDrawing: false, startX: 0, startY: 0, currentPath: [], zoom: 1, panX: 0, panY: 0, isPanning: false,
    selectedElement: null, images: {}
  },
  // Slides state
  slides: [{ id: 'slide-1', elements: [], background: '#1a1f2e' }], currentSlide: 0,
  // Dots
  dots: []
};

// ─── UTILS ───
const $ = id => document.getElementById(id);
function generateCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('') }
function formatBytes(b) { if (b < 1024) return b + 'B'; if (b < 1048576) return (b / 1024).toFixed(1) + 'KB'; return (b / 1048576).toFixed(1) + 'MB' }
function sanitizeStr(s, m = 500) { return typeof s !== 'string' ? '' : s.replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, m) }
function safeFilename(n) { return n.replace(/[^a-zA-Z0-9._\-]/g, '_').substring(0, SEC.MAX_FILENAME_LEN) }
function genId() { return Math.random().toString(36).substring(2, 10) }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

// ─── SECURITY ───
function validateMsg(msg) {
  if (!msg || typeof msg !== 'object') return false; if (!SEC.ALLOWED_TYPES.has(msg.type)) return false;
  if (msg.filename && typeof msg.filename === 'string' && (msg.filename.length > SEC.MAX_FILENAME_LEN || /[\/\\<>:"|?*]/.test(msg.filename))) return false;
  if (msg.text && typeof msg.text === 'string' && msg.text.length > SEC.MAX_CHAT_LEN) return false;
  if (msg.content && typeof msg.content === 'string' && msg.content.length > SEC.MAX_FILE_SIZE) return false; return true
}
function checkRateLimit(pid) {
  const now = Date.now(); if (!state.rateLimits[pid] || state.rateLimits[pid].resetAt < now) state.rateLimits[pid] = { count: 0, resetAt: now + 1000 };
  state.rateLimits[pid].count++; return state.rateLimits[pid].count <= SEC.RATE_LIMIT_PER_SEC
}
function isOwner() { return state.role === 'owner' }
function canEdit() { return state.role === 'owner' || state.role === 'editor' }
function canDownload() { return state.role === 'owner' || (state.settings.downloadAllowed && state.role !== 'viewer') }
function getPeerRole(pid) { return state.peers[pid]?.role || 'viewer' }
function peerCanEdit(pid) { const r = getPeerRole(pid); return r === 'owner' || r === 'editor' }

// ─── TOAST ───
function toast(msg, type = 'info', dur = 3500) {
  const icons = {
    success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(16,185,129,.2)"/><path d="M9 12l2 2 4-4" stroke="#10b981" stroke-width="2" stroke-linecap="round"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(239,68,68,.2)"/><path d="M15 9l-6 6M9 9l6 6" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(124,58,237,.2)"/><path d="M12 8v4M12 16h.01" stroke="#a78bfa" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  const el = document.createElement('div'); el.className = `toast toast-${type}`;
  el.innerHTML = `${icons[type] || icons.info}<span>${String(msg).replace(/</g, '&lt;')}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('toast-out'); el.addEventListener('animationend', () => el.remove(), { once: true }) }, dur)
}

function showModal({ icon = '', title = '', body = '', confirmText = 'OK', cancelText = 'Cancel', onConfirm, dangerous = false }) {
  $('modal-icon').textContent = icon; $('modal-title').textContent = title; $('modal-body').textContent = body;
  $('modal-confirm').textContent = confirmText; $('modal-cancel').textContent = cancelText;
  $('modal-backdrop').classList.remove('hidden');
  const close = () => $('modal-backdrop').classList.add('hidden');
  $('modal-confirm').onclick = () => { close(); onConfirm?.() }; $('modal-cancel').onclick = close;
  $('modal-backdrop').onclick = e => { if (e.target === $('modal-backdrop')) close() }
}

// ─── SCREENS ───
function showScreen(name) { ['screen-landing', 'screen-workspace'].forEach(id => $(id).classList.remove('active')); $(name).classList.add('active') }

function switchView(view) {
  state.currentView = view;
  ['editor', 'canvas', 'slides'].forEach(v => {
    const panel = $('view-' + v); const tab = $('tab-' + v);
    if (v === view) { panel?.classList.add('active'); tab?.classList.add('active') }
    else { panel?.classList.remove('active'); tab?.classList.remove('active') }
  });
  $('status-view-mode').textContent = view.charAt(0).toUpperCase() + view.slice(1);
  if (view === 'editor' && state.editor) setTimeout(() => state.editor.layout(), 100);
  if (view === 'canvas') resizeCanvas();
  if (view === 'slides') resizeSlideCanvas()
}

// ─── FILE MANAGEMENT ───
function addFileToWorkspace(name, content) {
  const sn = safeFilename(name); if (!sn) return null; const lang = getLang(sn);
  if (!state.workspace[sn]) state.localVersion[sn] = 0;
  state.workspace[sn] = { content, language: lang, version: state.localVersion[sn] || 0, modified: false };
  renderFileTree(); renderTabs(); return sn
}
function removeFileFromWorkspace(name) {
  if (!state.workspace[name]) return; delete state.workspace[name]; delete state.localVersion[name];
  if (state.activeFile === name) { const files = Object.keys(state.workspace); switchFile(files[0] || null) } renderFileTree(); renderTabs()
}
function readFileAsText(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = () => rej(r.error); r.readAsText(file, 'utf-8') }) }
async function loadFiles(fileList) {
  const results = []; for (const file of fileList) {
    if (file.size > SEC.MAX_FILE_SIZE) { toast(`${file.name} too large`, 'error'); continue }
    const content = await readFileAsText(file).catch(() => ''); results.push({ name: file.name, content })
  } return results
}
function switchFile(filename) {
  if (!filename || !state.workspace[filename]) {
    state.activeFile = null; if (state.editor) state.editor.setValue('');
    $('monaco-container').classList.add('hidden'); $('editor-empty-state')?.classList.remove('hidden');
    updateStatusBar(); renderFileTree(); renderTabs(); return
  }
  state.activeFile = filename; const file = state.workspace[filename];
  if (state.editor) {
    state.suppressChange = true;
    const model = monaco.editor.getModel(monaco.Uri.parse(`file:///${filename}`)) || monaco.editor.createModel(file.content, file.language, monaco.Uri.parse(`file:///${filename}`));
    if (state.editor.getModel() !== model) state.editor.setModel(model);
    if (model.getValue() !== file.content) model.setValue(file.content);
    state.editor.updateOptions({ readOnly: !canEdit() }); setTimeout(() => { state.suppressChange = false }, 50)
  }
  $('monaco-container').classList.remove('hidden'); $('editor-empty-state')?.classList.add('hidden');
  if (state.currentView !== 'editor') switchView('editor');
  updateStatusBar(); renderFileTree(); renderTabs(); broadcast({ type: 'file-open', filename })
}

// ─── P2P ───
function initPeer(id, cb) {
  if (state.peer) try { state.peer.destroy() } catch (e) { }
  state.peer = new Peer(id, { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } });
  state.peer.on('open', pid => { state.myId = pid; cb(pid) });
  state.peer.on('error', err => {
    const msgs = { 'peer-unavailable': 'Room not found.', 'network': 'Network error.', 'unavailable-id': 'Code taken, retry.' };
    toast(msgs[err.type] || 'Connection error: ' + err.type, 'error', 6000); $('join-status')?.classList.add('hidden');
    const bj = $('btn-join'); if (bj) bj.disabled = false; updateStatus('error', 'Error')
  });
  state.peer.on('disconnected', () => { updateStatus('connecting', 'Reconnecting…'); try { state.peer.reconnect() } catch (e) { } })
}

function setupConn(conn) {
  conn.on('open', () => {
    state.conns[conn.peer] = conn;
    if (state.role === 'owner') {
      const role = state.settings.defaultRole;
      if (!state.peers[conn.peer]) state.peers[conn.peer] = { name: 'Peer', color: PEER_COLORS[Object.keys(state.peers).length % PEER_COLORS.length], role };
      setTimeout(() => sendWorkspace(conn), 200)
    }
    updatePeersUI(); updateStatus('online', 'Connected')
  });
  conn.on('data', data => handleMessage(conn, data));
  conn.on('close', () => {
    delete state.conns[conn.peer]; delete state.peers[conn.peer]; delete state.decorations[conn.peer]; delete state.rateLimits[conn.peer];
    updatePeersUI(); renderRemoteCursors(); if (!Object.keys(state.conns).length) updateStatus('connecting', 'Waiting…'); addChatSystem('A peer disconnected')
  });
  conn.on('error', err => console.error('[Conn]', err))
}

function broadcast(msg, excludeId = null) { Object.entries(state.conns).forEach(([id, conn]) => { if (id !== excludeId && conn.open) try { conn.send(msg) } catch (e) { } }) }
function sendTo(pid, msg) { const conn = state.conns[pid]; if (conn?.open) try { conn.send(msg) } catch (e) { } }

function sendWorkspace(conn) {
  const files = {}; Object.entries(state.workspace).forEach(([n, f]) => { files[n] = { content: f.content, language: f.language, version: f.version } });
  conn.send({
    type: 'workspace-data', files, activeFile: state.activeFile, settings: state.settings, myName: state.myName, myColor: state.myColor,
    peerRole: state.peers[conn.peer]?.role || state.settings.defaultRole,
    canvasElements: state.canvas.elements, slides: state.slides, dots: state.dots
  })
}

// ─── MESSAGE HANDLER ───
function handleMessage(conn, msg) {
  if (!validateMsg(msg) || !checkRateLimit(conn.peer)) return;
  switch (msg.type) {
    case 'peer-info': {
      if (!state.peers[conn.peer]) state.peers[conn.peer] = { role: state.settings.defaultRole };
      state.peers[conn.peer].name = sanitizeStr(msg.name || 'Peer', SEC.MAX_NAME_LEN);
      state.peers[conn.peer].color = /^#[0-9A-Fa-f]{6}$/.test(msg.color || '') ? msg.color : '#54a0ff';
      state.peers[conn.peer].conn = conn; updatePeersUI(); addChatSystem(`${state.peers[conn.peer].name} joined`); break
    }
    case 'workspace-data': {
      state.settings = { downloadAllowed: !!msg.settings?.downloadAllowed, defaultRole: msg.settings?.defaultRole || 'editor' };
      state.role = ['owner', 'editor', 'viewer'].includes(msg.peerRole) ? msg.peerRole : 'viewer';
      if (!state.peers[conn.peer]) state.peers[conn.peer] = { role: 'owner' };
      state.peers[conn.peer].name = sanitizeStr(msg.myName || 'Host', SEC.MAX_NAME_LEN);
      state.peers[conn.peer].color = /^#[0-9A-Fa-f]{6}$/.test(msg.myColor || '') ? msg.myColor : '#a78bfa';
      state.workspace = {}; state.localVersion = {};
      const files = msg.files && typeof msg.files === 'object' ? msg.files : {};
      Object.entries(files).forEach(([n, f]) => {
        if (typeof f.content !== 'string' || f.content.length > SEC.MAX_FILE_SIZE) return;
        const sn = safeFilename(n); state.workspace[sn] = { content: f.content, language: f.language || getLang(sn), version: f.version || 0, modified: false }; state.localVersion[sn] = f.version || 0
      });
      if (Array.isArray(msg.canvasElements)) state.canvas.elements = msg.canvasElements;
      if (Array.isArray(msg.slides)) state.slides = msg.slides;
      if (Array.isArray(msg.dots)) state.dots = msg.dots;
      const active = safeFilename(msg.activeFile || ''); renderFileTree(); renderTabs(); renderSlidesList();
      if (state.monacoReady) switchFile(active && state.workspace[active] ? active : Object.keys(state.workspace)[0] || null);
      updateStatus('online', 'Connected'); updateRoleBadge(); updatePeersUI(); applySettingsToUI();
      toast('Workspace loaded!', 'success'); break
    }
    case 'sync': {
      if (!msg.filename || !state.workspace[msg.filename]) return; if (typeof msg.content !== 'string' || msg.content.length > SEC.MAX_FILE_SIZE) return;
      if (!peerCanEdit(conn.peer)) return; const ver = parseInt(msg.version) || 0; if (ver < (state.localVersion[msg.filename] || 0)) return;
      state.workspace[msg.filename].content = msg.content; state.workspace[msg.filename].version = ver; state.localVersion[msg.filename] = ver;
      if (state.activeFile === msg.filename && state.editor) {
        state.suppressChange = true; const model = state.editor.getModel();
        if (model && model.getValue() !== msg.content) { const pos = state.editor.getPosition(); model.setValue(msg.content); if (pos) state.editor.setPosition(pos) }
        setTimeout(() => { state.suppressChange = false }, 50)
      }
      if (state.role === 'owner') broadcast(msg, conn.peer); break
    }
    case 'cursor': {
      if (!state.peers[conn.peer]) return; state.peers[conn.peer].cursor = msg.pos; state.peers[conn.peer].cursorFile = msg.filename;
      if (msg.filename === state.activeFile) renderRemoteCursors(); break
    }
    case 'canvas-draw': {
      if (!peerCanEdit(conn.peer)) return; if (msg.element) state.canvas.elements.push(msg.element);
      renderCanvas(); if (state.role === 'owner') broadcast(msg, conn.peer); break
    }
    case 'canvas-state': { if (Array.isArray(msg.elements)) state.canvas.elements = msg.elements; renderCanvas(); break }
    case 'canvas-cursor': { if (!state.peers[conn.peer]) return; state.peers[conn.peer].canvasCursor = msg.pos; renderCanvasCursors(); break }
    case 'slide-update': {
      if (!peerCanEdit(conn.peer)) return; if (Array.isArray(msg.slides)) state.slides = msg.slides;
      if (typeof msg.currentSlide === 'number') state.currentSlide = msg.currentSlide;
      renderSlidesList(); renderCurrentSlide(); if (state.role === 'owner') broadcast(msg, conn.peer); break
    }
    case 'dot-update': { if (Array.isArray(msg.dots)) state.dots = msg.dots; renderCanvas(); if (state.role === 'owner') broadcast(msg, conn.peer); break }
    case 'file-open': { const fn = safeFilename(msg.filename || ''); if (state.peers[conn.peer]) state.peers[conn.peer].activeFile = fn; break }
    case 'file-rename': {
      if (!peerCanEdit(conn.peer)) return; const oN = safeFilename(msg.oldName || ''), nN = safeFilename(msg.newName || '');
      if (!oN || !nN || !state.workspace[oN] || state.workspace[nN]) return; const fi = state.workspace[oN];
      state.workspace[nN] = { ...fi, language: getLang(nN) }; delete state.workspace[oN];
      if (state.activeFile === oN) state.activeFile = nN; renderFileTree(); renderTabs(); if (state.role === 'owner') broadcast(msg, conn.peer); break
    }
    case 'file-delete': { if (!peerCanEdit(conn.peer)) return; const fn = safeFilename(msg.filename || ''); if (state.workspace[fn]) removeFileFromWorkspace(fn); break }
    case 'permission-change-recv': {
      if (typeof msg.role !== 'string') return; const nr = ['editor', 'viewer'].includes(msg.role) ? msg.role : 'viewer';
      if (msg.targetId === state.myId) {
        state.role = nr; updateRoleBadge(); if (state.editor) state.editor.updateOptions({ readOnly: !canEdit() });
        toast(`Role changed to: ${nr}`, 'info')
      } break
    }
    case 'kick': { if (msg.targetId === state.myId) { toast('You were removed.', 'error', 6000); leaveRoom(false) } break }
    case 'chat': {
      if (typeof msg.text !== 'string' || !msg.text.trim()) return; const name = sanitizeStr(state.peers[conn.peer]?.name || 'Peer', SEC.MAX_NAME_LEN);
      const color = state.peers[conn.peer]?.color || '#54a0ff'; addChatMessage(name, sanitizeStr(msg.text, SEC.MAX_CHAT_LEN), color, false); break
    }
    case 'settings-update': {
      if (state.role === 'owner') return; if (typeof msg.settings?.downloadAllowed === 'boolean') state.settings.downloadAllowed = msg.settings.downloadAllowed;
      if (['editor', 'viewer'].includes(msg.settings?.defaultRole)) state.settings.defaultRole = msg.settings.defaultRole; applySettingsToUI(); break
    }
    case 'request-workspace': { if (state.role === 'owner') sendWorkspace(conn); break }
  }
}
// ─── UI RENDERERS (Part 2) ───
// Canvas, Slides, IDE events, boot logic

function renderFileTree() {
    const tree = $('file-tree'); tree.innerHTML = ''; const files = Object.keys(state.workspace).sort();
    if (!files.length) { tree.innerHTML = '<div style="padding:12px;font-size:.75rem;color:var(--text-3);text-align:center">No files yet</div>'; return }
    files.forEach(name => {
        const lang = getLang(name), color = getLangColor(lang), isActive = name === state.activeFile, file = state.workspace[name];
        const el = document.createElement('div'); el.className = `file-tree-item${isActive ? ' active' : ''}${file.modified ? ' modified' : ''}`; el.dataset.filename = name;
        el.innerHTML = `<svg class="ft-icon" viewBox="0 0 24 24" fill="none" style="color:${color}"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/></svg><span class="ft-name">${escapeHtml(name)}</span><div class="ft-modified"></div>`;
        el.addEventListener('click', () => switchFile(name)); el.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, name) }); tree.appendChild(el)
    })
}

function renderTabs() {
    const tabs = $('file-tabs'); tabs.innerHTML = '';
    Object.keys(state.workspace).forEach(name => {
        const lang = getLang(name), color = getLangColor(lang), isActive = name === state.activeFile, file = state.workspace[name];
        const tab = document.createElement('button'); tab.className = `file-tab${isActive ? ' active' : ''}${file.modified ? ' unsaved' : ''}`;
        tab.innerHTML = `<span class="tab-lang-dot" style="background:${color}"></span><span>${escapeHtml(name)}</span><button class="tab-close" title="Close">×</button>`;
        tab.addEventListener('click', e => { if (e.target.classList.contains('tab-close')) return; switchFile(name) });
        tab.querySelector('.tab-close').addEventListener('click', e => { e.stopPropagation(); closeTab(name) }); tabs.appendChild(tab)
    })
}

function renderPeersList() {
    const list = $('peers-list'); list.innerHTML = '';
    const myInit = (state.myName || '?')[0].toUpperCase(); const selfEl = document.createElement('div'); selfEl.className = 'peer-card';
    selfEl.innerHTML = `<div class="peer-avatar" style="background:${state.myColor}">${myInit}</div><div class="peer-card-info"><div class="peer-card-name">${escapeHtml(state.myName)} (You)</div><div class="peer-card-role"><span class="peer-role-badge role-${state.role}">${state.role}</span></div></div><span class="peer-online-dot"></span>`;
    list.appendChild(selfEl);
    Object.entries(state.peers).forEach(([pid, peer]) => {
        const init = (peer.name || 'P')[0].toUpperCase(); const el = document.createElement('div'); el.className = 'peer-card';
        const amOwner = state.role === 'owner';
        el.innerHTML = `<div class="peer-avatar" style="background:${peer.color || '#54a0ff'}">${init}</div><div class="peer-card-info"><div class="peer-card-name">${escapeHtml(peer.name || 'Peer')}</div><div class="peer-card-role"><span class="peer-role-badge role-${peer.role || 'viewer'}">${peer.role || 'viewer'}</span></div></div>${amOwner ? `<div class="peer-actions"><button class="peer-action-btn" data-peer="${escapeHtml(pid)}" data-action="toggle-role">${peer.role === 'editor' ? 'Viewer' : 'Editor'}</button><button class="peer-action-btn kick-btn" data-peer="${escapeHtml(pid)}" data-action="kick">Kick</button></div>` : '<span class="peer-online-dot"></span>'}`;
        list.appendChild(el)
    });
    list.querySelectorAll('.peer-action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.action === 'toggle-role') togglePeerRole(btn.dataset.peer); if (btn.dataset.action === 'kick') kickPeer(btn.dataset.peer)
        })
    });
    const total = Object.keys(state.peers).length + 1; $('peer-count-label').textContent = total + ' peer' + (total !== 1 ? 's' : '');
    const dot = document.querySelector('.peers-badge .peer-dot'); if (dot) dot.className = 'peer-dot' + (Object.keys(state.conns).length > 0 ? ' active' : '')
}
function updatePeersUI() { renderPeersList() }

function renderRemoteCursors() {
    if (!state.editor) return;
    Object.entries(state.decorations).forEach(([id, decs]) => { if (Array.isArray(decs)) state.editor.deltaDecorations(decs, []); state.decorations[id] = [] });
    Object.entries(state.peers).forEach(([pid, peer]) => {
        if (!peer.cursor || peer.cursorFile !== state.activeFile) return;
        const { lineNumber, column } = peer.cursor; if (!lineNumber || !column) return; const color = peer.color || '#54a0ff';
        const sid = `cs-${pid.replace(/[^a-z0-9]/gi, '_')}`;
        if (!document.getElementById(sid)) { const s = document.createElement('style'); s.id = sid; s.textContent = `.rc-${pid.replace(/[^a-z0-9]/gi, '_')}{border-left:2px solid ${color};}`; document.head.appendChild(s) }
        const nd = state.editor.deltaDecorations(state.decorations[pid] || [], [{
            range: new monaco.Range(lineNumber, column, lineNumber, column),
            options: { className: `rc-${pid.replace(/[^a-z0-9]/gi, '_')}`, hoverMessage: { value: `**${peer.name || 'Peer'}**` }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
        }]);
        state.decorations[pid] = nd
    })
}

function addChatMessage(name, text, color, isOwn) {
    const msgs = $('chat-messages'); const el = document.createElement('div'); el.className = `chat-msg${isOwn ? ' own' : ''}`;
    const now = new Date(); const t = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    el.innerHTML = `<div class="chat-msg-header"><span class="chat-msg-name" style="color:${color}">${escapeHtml(name)}</span><span class="chat-msg-time">${t}</span></div><div class="chat-msg-text">${escapeHtml(text)}</div>`;
    msgs.appendChild(el); msgs.scrollTop = msgs.scrollHeight
}
function addChatSystem(text) { const msgs = $('chat-messages'); const el = document.createElement('div'); el.className = 'chat-system'; el.textContent = text; msgs.appendChild(el); msgs.scrollTop = msgs.scrollHeight }
function updateStatusBar() { $('status-filename').textContent = state.activeFile || 'No file'; $('status-lang').textContent = state.activeFile ? getLang(state.activeFile) : 'Plain Text' }
function updateStatus(type, text) { $('status-conn-dot').className = 'status-dot ' + type; $('status-conn-text').textContent = text }
function updateRoleBadge() { const el = $('status-role-badge'); el.textContent = state.role || 'viewer'; el.className = `status-item role-badge-${state.role || 'viewer'}` }
function applySettingsToUI() {
    const isHost = state.role === 'owner'; $('toggle-download').checked = state.settings.downloadAllowed;
    $('select-default-role').value = state.settings.defaultRole; $('settings-controls').style.pointerEvents = isHost ? 'auto' : 'none';
    $('settings-controls').style.opacity = isHost ? '1' : '0.5'; $('settings-host-only').style.display = isHost ? 'none' : ''
}

function showContextMenu(e, filename) {
    state.contextTarget = filename; const menu = $('context-menu'); menu.classList.remove('hidden');
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px'; menu.style.top = Math.min(e.clientY, window.innerHeight - 140) + 'px';
    $('ctx-download').style.display = canDownload() ? '' : 'none'; $('ctx-delete').style.display = canEdit() ? '' : 'none'; $('ctx-rename').style.display = canEdit() ? '' : 'none'
}
function hideContextMenu() { $('context-menu').classList.add('hidden'); state.contextTarget = null }

function togglePeerRole(pid) {
    if (!isOwner()) return; const peer = state.peers[pid]; if (!peer) return;
    const nr = peer.role === 'editor' ? 'viewer' : 'editor'; peer.role = nr; sendTo(pid, { type: 'permission-change-recv', targetId: pid, role: nr });
    updatePeersUI(); toast(`${peer.name} is now ${nr}`, 'info')
}
function kickPeer(pid) {
    if (!isOwner()) return; const peer = state.peers[pid];
    showModal({
        icon: '🚫', title: 'Kick Peer?', body: `Remove ${peer?.name || 'this peer'}?`, confirmText: 'Kick',
        onConfirm: () => {
            sendTo(pid, { type: 'kick', targetId: pid }); setTimeout(() => {
                if (state.conns[pid]) try { state.conns[pid].close() } catch (e) { }
                delete state.conns[pid]; delete state.peers[pid]; updatePeersUI()
            }, 300)
        }
    })
}
function closeTab(fn) {
    if (state.workspace[fn]?.modified) showModal({ icon: '⚠️', title: 'Unsaved', body: `Close ${fn}?`, confirmText: 'Close', onConfirm: () => removeFileFromWorkspace(fn) });
    else removeFileFromWorkspace(fn)
}
function downloadFile(fn) {
    if (!canDownload()) { toast('Download disabled.', 'error'); return } const file = state.workspace[fn]; if (!file) return;
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: fn }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`Downloading ${fn}`, 'success')
}
function performSearch(query) {
    const results = $('search-results'); results.innerHTML = ''; if (!query.trim()) return; const q = query.toLowerCase(); let total = 0;
    Object.entries(state.workspace).forEach(([name, file]) => {
        const lines = file.content.split('\n'); const matches = [];
        lines.forEach((line, i) => { if (line.toLowerCase().includes(q)) matches.push({ n: i + 1, t: line.trim().substring(0, 80) }) });
        if (matches.length) {
            const hdr = document.createElement('div'); hdr.className = 'search-result-item';
            hdr.innerHTML = `<div class="search-result-file">${escapeHtml(name)} (${matches.length})</div>`; results.appendChild(hdr);
            matches.slice(0, 5).forEach(m => {
                const el = document.createElement('div'); el.className = 'search-result-item';
                const hl = escapeHtml(m.t).replace(new RegExp(escapeHtml(query), 'gi'), s => `<mark>${s}</mark>`);
                el.innerHTML = `<div class="search-result-line">${m.n}: ${hl}</div>`;
                el.addEventListener('click', () => { switchFile(name); setTimeout(() => { if (state.editor) { state.editor.revealLineInCenter(m.n); state.editor.setPosition({ lineNumber: m.n, column: 1 }); state.editor.focus() } }, 100) });
                results.appendChild(el)
            }); total += matches.length
        }
    });
    if (!total) results.innerHTML = '<div style="padding:12px;font-size:.75rem;color:var(--text-3)">No results</div>'
}

// ─── CANVAS ENGINE ───
let canvasCtx = null;
function resizeCanvas() {
    const wrapper = $('canvas-wrapper'); const canvas = $('main-canvas'); if (!wrapper || !canvas) return;
    canvas.width = wrapper.clientWidth; canvas.height = wrapper.clientHeight; canvasCtx = canvas.getContext('2d'); renderCanvas()
}

function renderCanvas() {
    if (!canvasCtx) return; const ctx = canvasCtx; const canvas = $('main-canvas');
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save(); ctx.translate(state.canvas.panX, state.canvas.panY); ctx.scale(state.canvas.zoom, state.canvas.zoom);
    // Draw elements
    state.canvas.elements.forEach(el => {
        ctx.save(); ctx.strokeStyle = el.color || '#a78bfa'; ctx.fillStyle = el.color || '#a78bfa'; ctx.lineWidth = el.strokeWidth || 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        switch (el.type) {
            case 'path': if (el.points?.length > 1) {
                ctx.beginPath(); ctx.moveTo(el.points[0].x, el.points[0].y);
                for (let i = 1; i < el.points.length; i++)ctx.lineTo(el.points[i].x, el.points[i].y); ctx.stroke()
            } break;
            case 'line': ctx.beginPath(); ctx.moveTo(el.x1, el.y1); ctx.lineTo(el.x2, el.y2); ctx.stroke(); break;
            case 'rect': ctx.strokeRect(el.x, el.y, el.w, el.h); break;
            case 'circle': { const rx = Math.abs(el.w / 2), ry = Math.abs(el.h / 2); ctx.beginPath(); ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, rx, ry, 0, 0, Math.PI * 2); ctx.stroke() } break;
            case 'text': ctx.font = `${el.fontSize || 16}px Inter,sans-serif`; ctx.fillText(el.text, el.x, el.y); break;
            case 'image': if (el.imgData) {
                let img = state.canvas.images[el.id]; if (!img) { img = new Image(); img.src = el.imgData; state.canvas.images[el.id] = img; img.onload = () => renderCanvas() }
                if (img.complete) ctx.drawImage(img, el.x, el.y, el.w, el.h)
            } break
        }ctx.restore()
    });
    // Draw dots
    state.dots.forEach(dot => {
        ctx.save(); ctx.fillStyle = dot.color || '#fbbf24'; ctx.strokeStyle = dot.color || '#fbbf24'; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.arc(dot.x, dot.y, 10, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(dot.x, dot.y, 16, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(dot.x, dot.y, 22, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        if (dot.label) { ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Inter,sans-serif'; ctx.fillText(dot.label, dot.x + 18, dot.y + 4) }
        ctx.restore()
    });
    // Current drawing preview
    if (state.canvas.isDrawing) {
        ctx.save(); ctx.strokeStyle = state.canvas.color; ctx.lineWidth = state.canvas.strokeWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (state.canvas.tool === 'pen' && state.canvas.currentPath.length > 1) {
            ctx.beginPath(); ctx.moveTo(state.canvas.currentPath[0].x, state.canvas.currentPath[0].y);
            for (let i = 1; i < state.canvas.currentPath.length; i++)ctx.lineTo(state.canvas.currentPath[i].x, state.canvas.currentPath[i].y); ctx.stroke()
        }
        else if (state.canvas.tool === 'line') { ctx.beginPath(); ctx.moveTo(state.canvas.startX, state.canvas.startY); ctx.lineTo(state.canvas.currentX, state.canvas.currentY); ctx.stroke() }
        else if (state.canvas.tool === 'rect') { const w = state.canvas.currentX - state.canvas.startX, h = state.canvas.currentY - state.canvas.startY; ctx.strokeRect(state.canvas.startX, state.canvas.startY, w, h) }
        else if (state.canvas.tool === 'circle') {
            const w = state.canvas.currentX - state.canvas.startX, h = state.canvas.currentY - state.canvas.startY;
            ctx.beginPath(); ctx.ellipse(state.canvas.startX + w / 2, state.canvas.startY + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); ctx.stroke()
        }
        ctx.restore()
    }
    ctx.restore()
}

function renderCanvasCursors() {
    const layer = $('canvas-cursors-layer'); layer.innerHTML = '';
    Object.entries(state.peers).forEach(([pid, peer]) => {
        if (!peer.canvasCursor) return;
        const div = document.createElement('div'); div.className = 'remote-cursor';
        div.style.left = (peer.canvasCursor.x * state.canvas.zoom + state.canvas.panX) + 'px';
        div.style.top = (peer.canvasCursor.y * state.canvas.zoom + state.canvas.panY) + 'px';
        div.innerHTML = `<div class="remote-cursor-dot" style="background:${peer.color}"></div><div class="remote-cursor-label" style="background:${peer.color}">${escapeHtml(peer.name || 'Peer')}</div>`;
        layer.appendChild(div)
    })
}

function getCanvasCoords(e) {
    const canvas = $('main-canvas'); const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left - state.canvas.panX) / state.canvas.zoom, y: (e.clientY - rect.top - state.canvas.panY) / state.canvas.zoom }
}

function setupCanvas() {
    const canvas = $('main-canvas'); if (!canvas) return;
    canvas.addEventListener('mousedown', e => {
        if (e.button === 1 || e.button === 2 || (e.button === 0 && (e.altKey || e.shiftKey))) { state.canvas.isPanning = true; state.canvas.lastPanX = e.clientX; state.canvas.lastPanY = e.clientY; canvas.style.cursor = 'grabbing'; return }
        if (!canEdit() && state.canvas.tool !== 'select') return; const pos = getCanvasCoords(e);
        if (state.canvas.tool === 'dot') { showDotModal(pos.x, pos.y); return }
        if (state.canvas.tool === 'text') { showTextInput(e.clientX, e.clientY, pos.x, pos.y); return }
        if (state.canvas.tool === 'image') { $('canvas-image-input').click(); state.canvas.imgPos = pos; return }
        if (state.canvas.tool === 'select') {// Check dot click
            const clickedDot = state.dots.find(d => Math.hypot(d.x - pos.x, d.y - pos.y) < 16);
            if (clickedDot && clickedDot.file && state.workspace[clickedDot.file]) { switchFile(clickedDot.file); return } return
        }
        if (state.canvas.tool === 'eraser') {
            const idx = state.canvas.elements.findIndex(el => {
                if (el.type === 'path') return el.points?.some(p => Math.hypot(p.x - pos.x, p.y - pos.y) < 15);
                if (el.type === 'rect') return pos.x >= el.x && pos.x <= el.x + el.w && pos.y >= el.y && pos.y <= el.y + el.h;
                if (el.type === 'circle') return Math.hypot(pos.x - (el.x + el.w / 2), pos.y - (el.y + el.h / 2)) < Math.max(Math.abs(el.w), Math.abs(el.h)) / 2 + 10;
                return Math.hypot((el.x1 || el.x) - pos.x, (el.y1 || el.y) - pos.y) < 15
            });
            if (idx >= 0) { state.canvas.undoStack.push([...state.canvas.elements]); state.canvas.elements.splice(idx, 1); renderCanvas(); broadcastCanvas() } return
        }
        state.canvas.isDrawing = true; state.canvas.startX = pos.x; state.canvas.startY = pos.y; state.canvas.currentX = pos.x; state.canvas.currentY = pos.y;
        if (state.canvas.tool === 'pen') state.canvas.currentPath = [{ x: pos.x, y: pos.y }]
    });

    canvas.addEventListener('mousemove', e => {
        const pos = getCanvasCoords(e);
        broadcast({ type: 'canvas-cursor', pos: { x: pos.x, y: pos.y } });
        if (state.canvas.isPanning) {
            state.canvas.panX += e.clientX - state.canvas.lastPanX; state.canvas.panY += e.clientY - state.canvas.lastPanY;
            state.canvas.lastPanX = e.clientX; state.canvas.lastPanY = e.clientY; renderCanvas(); return
        }
        if (!state.canvas.isDrawing) return; state.canvas.currentX = pos.x; state.canvas.currentY = pos.y;
        if (state.canvas.tool === 'pen') state.canvas.currentPath.push({ x: pos.x, y: pos.y }); renderCanvas()
    });

    const finishDraw = () => {
        if (state.canvas.isPanning) { state.canvas.isPanning = false; $('main-canvas').style.cursor = 'crosshair'; return }
        if (!state.canvas.isDrawing) return; state.canvas.isDrawing = false; state.canvas.undoStack.push([...state.canvas.elements]); state.canvas.redoStack = [];
        const c = state.canvas.color, sw = state.canvas.strokeWidth;
        if (state.canvas.tool === 'pen' && state.canvas.currentPath.length > 1) state.canvas.elements.push({ type: 'path', points: [...state.canvas.currentPath], color: c, strokeWidth: sw, id: genId() });
        else if (state.canvas.tool === 'line') state.canvas.elements.push({ type: 'line', x1: state.canvas.startX, y1: state.canvas.startY, x2: state.canvas.currentX, y2: state.canvas.currentY, color: c, strokeWidth: sw, id: genId() });
        else if (state.canvas.tool === 'rect') {
            const w = state.canvas.currentX - state.canvas.startX, h = state.canvas.currentY - state.canvas.startY;
            state.canvas.elements.push({ type: 'rect', x: state.canvas.startX, y: state.canvas.startY, w, h, color: c, strokeWidth: sw, id: genId() })
        }
        else if (state.canvas.tool === 'circle') {
            const w = state.canvas.currentX - state.canvas.startX, h = state.canvas.currentY - state.canvas.startY;
            state.canvas.elements.push({ type: 'circle', x: state.canvas.startX, y: state.canvas.startY, w, h, color: c, strokeWidth: sw, id: genId() })
        }
        state.canvas.currentPath = []; renderCanvas(); broadcastCanvas()
    };
    canvas.addEventListener('mouseup', finishDraw); canvas.addEventListener('mouseleave', finishDraw);

    canvas.addEventListener('wheel', e => {
        e.preventDefault(); const delta = e.deltaY > 0 ? 0.9 : 1.1; state.canvas.zoom = Math.max(0.1, Math.min(5, state.canvas.zoom * delta));
        $('canvas-zoom-label').textContent = Math.round(state.canvas.zoom * 100) + '%'; renderCanvas()
    }, { passive: false });

    // Tool buttons
    document.querySelectorAll('[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.canvas.tool = btn.dataset.tool;
            document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active')); btn.classList.add('active')
        })
    });
    $('canvas-color')?.addEventListener('input', e => { state.canvas.color = e.target.value });
    $('canvas-stroke-width')?.addEventListener('change', e => { state.canvas.strokeWidth = parseInt(e.target.value) });
    $('btn-canvas-undo')?.addEventListener('click', () => {
        if (state.canvas.undoStack.length) {
            state.canvas.redoStack.push([...state.canvas.elements]);
            state.canvas.elements = state.canvas.undoStack.pop(); renderCanvas(); broadcastCanvas()
        }
    });
    $('btn-canvas-redo')?.addEventListener('click', () => {
        if (state.canvas.redoStack.length) {
            state.canvas.undoStack.push([...state.canvas.elements]);
            state.canvas.elements = state.canvas.redoStack.pop(); renderCanvas(); broadcastCanvas()
        }
    });
    $('btn-canvas-clear')?.addEventListener('click', () => {
        showModal({
            icon: '🗑️', title: 'Clear Canvas?', body: 'This will remove all drawings.', confirmText: 'Clear',
            onConfirm: () => { state.canvas.undoStack.push([...state.canvas.elements]); state.canvas.elements = []; state.dots = []; renderCanvas(); broadcastCanvas(); broadcast({ type: 'dot-update', dots: state.dots }) }
        })
    });
    $('btn-canvas-export')?.addEventListener('click', () => {
        const canvas = $('main-canvas'); const url = canvas.toDataURL('image/png');
        const a = document.createElement('a'); a.href = url; a.download = 'canvas-export.png'; a.click(); toast('Canvas exported!', 'success')
    });
    $('btn-zoom-in')?.addEventListener('click', () => { state.canvas.zoom = Math.min(5, state.canvas.zoom * 1.2); $('canvas-zoom-label').textContent = Math.round(state.canvas.zoom * 100) + '%'; renderCanvas() });
    $('btn-zoom-out')?.addEventListener('click', () => { state.canvas.zoom = Math.max(0.1, state.canvas.zoom / 1.2); $('canvas-zoom-label').textContent = Math.round(state.canvas.zoom * 100) + '%'; renderCanvas() });
    $('btn-zoom-fit')?.addEventListener('click', () => { state.canvas.zoom = 1; state.canvas.panX = 0; state.canvas.panY = 0; $('canvas-zoom-label').textContent = '100%'; renderCanvas() });

    // Image upload
    $('canvas-image-input')?.addEventListener('change', e => {
        const file = e.target.files[0]; if (!file) return; const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image(); img.onload = () => {
                const pos = state.canvas.imgPos || { x: 100, y: 100 };
                state.canvas.elements.push({ type: 'image', x: pos.x, y: pos.y, w: img.width > 400 ? 400 : img.width, h: img.width > 400 ? img.height * (400 / img.width) : img.height, imgData: ev.target.result, id: genId() });
                renderCanvas(); broadcastCanvas()
            }; img.src = ev.target.result
        }; reader.readAsDataURL(file); e.target.value = ''
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (state.currentView !== 'canvas') return; if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        const k = e.key.toLowerCase(); if (k === 'v') setTool('select'); if (k === 'p') setTool('pen'); if (k === 'l') setTool('line');
        if (k === 'r') setTool('rect'); if (k === 'c') setTool('circle'); if (k === 't') setTool('text'); if (k === 'i') setTool('image');
        if (k === 'd') setTool('dot'); if (k === 'e') setTool('eraser');
        if (e.ctrlKey && k === 'z') { e.preventDefault(); $('btn-canvas-undo')?.click() } if (e.ctrlKey && k === 'y') { e.preventDefault(); $('btn-canvas-redo')?.click() }
    });
    window.addEventListener('resize', () => { if (state.currentView === 'canvas') resizeCanvas(); if (state.currentView === 'slides') resizeSlideCanvas() })
}

function setTool(t) { state.canvas.tool = t; document.querySelectorAll('[data-tool]').forEach(b => { b.classList.toggle('active', b.dataset.tool === t) }) }
function broadcastCanvas() { broadcast({ type: 'canvas-state', elements: state.canvas.elements }) }

function showDotModal(x, y) {
    const sel = $('dot-file-select'); sel.innerHTML = '<option value="">— Select a file —</option>';
    Object.keys(state.workspace).forEach(f => { const opt = document.createElement('option'); opt.value = f; opt.textContent = f; sel.appendChild(opt) });
    $('dot-label-input').value = ''; $('dot-modal-backdrop').classList.remove('hidden');
    $('dot-modal-confirm').onclick = () => {
        const file = sel.value; const label = $('dot-label-input').value.trim();
        state.dots.push({ x, y, file, label: label || file || 'Dot', color: state.canvas.color, id: genId() });
        $('dot-modal-backdrop').classList.add('hidden'); renderCanvas(); broadcast({ type: 'dot-update', dots: state.dots })
    };
    $('dot-modal-cancel').onclick = () => $('dot-modal-backdrop').classList.add('hidden')
}

function showTextInput(cx, cy, canvasX, canvasY) {
    const overlay = $('canvas-text-overlay'); overlay.classList.remove('hidden');
    overlay.style.left = cx + 'px'; overlay.style.top = cy + 'px'; $('canvas-text-input').value = ''; $('canvas-text-input').focus();
    $('canvas-text-confirm').onclick = () => {
        const text = $('canvas-text-input').value.trim(); if (text) {
            state.canvas.elements.push({ type: 'text', x: canvasX, y: canvasY, text, fontSize: 16, color: state.canvas.color, id: genId() }); renderCanvas(); broadcastCanvas()
        }
        overlay.classList.add('hidden')
    };
    $('canvas-text-cancel').onclick = () => overlay.classList.add('hidden')
}

// ─── SLIDES ENGINE ───
let slideCtx = null;
function resizeSlideCanvas() {
    const wrapper = $('slide-canvas-wrapper'); const canvas = $('slide-canvas'); if (!wrapper || !canvas) return;
    const aspect = 16 / 9; const maxW = wrapper.clientWidth - 40, maxH = wrapper.clientHeight - 40;
    let w = maxW, h = w / aspect; if (h > maxH) { h = maxH; w = h * aspect }
    canvas.width = w; canvas.height = h; slideCtx = canvas.getContext('2d'); renderCurrentSlide()
}

function renderCurrentSlide() {
    if (!slideCtx) return; const ctx = slideCtx; const canvas = $('slide-canvas'); const slide = state.slides[state.currentSlide]; if (!slide) return;
    ctx.fillStyle = slide.background || '#1a1f2e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    (slide.elements || []).forEach(el => {
        ctx.save(); ctx.strokeStyle = el.color || '#a78bfa'; ctx.fillStyle = el.color || '#a78bfa'; ctx.lineWidth = el.strokeWidth || 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        switch (el.type) {
            case 'path': if (el.points?.length > 1) {
                ctx.beginPath(); ctx.moveTo(el.points[0].x, el.points[0].y);
                for (let i = 1; i < el.points.length; i++)ctx.lineTo(el.points[i].x, el.points[i].y); ctx.stroke()
            } break;
            case 'text': ctx.font = `${el.fontSize || 24}px Inter,sans-serif`; ctx.fillText(el.text, el.x, el.y); break;
            case 'rect': ctx.strokeRect(el.x, el.y, el.w, el.h); break
        }ctx.restore()
    });
    $('slide-counter').textContent = `Slide ${state.currentSlide + 1} / ${state.slides.length}`
}

function renderSlidesList() {
    const list = $('slides-list'); if (!list) return; list.innerHTML = '';
    state.slides.forEach((slide, i) => {
        const el = document.createElement('div'); el.className = `slide-thumb${i === state.currentSlide ? ' active' : ''}`;
        el.innerHTML = `<span class="slide-thumb-num">${i + 1}</span><span>Slide ${i + 1}</span>`;
        el.addEventListener('click', () => { state.currentSlide = i; renderCurrentSlide(); renderSlidesList() }); list.appendChild(el)
    })
}

function setupSlides() {
    $('btn-slide-prev')?.addEventListener('click', () => { if (state.currentSlide > 0) { state.currentSlide--; renderCurrentSlide(); renderSlidesList(); broadcastSlides() } });
    $('btn-slide-next')?.addEventListener('click', () => { if (state.currentSlide < state.slides.length - 1) { state.currentSlide++; renderCurrentSlide(); renderSlidesList(); broadcastSlides() } });
    const addSlide = () => { state.slides.push({ id: 'slide-' + genId(), elements: [], background: '#1a1f2e' }); state.currentSlide = state.slides.length - 1; renderCurrentSlide(); renderSlidesList(); broadcastSlides() };
    $('btn-slide-add')?.addEventListener('click', addSlide); $('btn-add-slide')?.addEventListener('click', addSlide);
    $('btn-slide-delete')?.addEventListener('click', () => {
        if (state.slides.length <= 1) { toast('Need at least one slide', 'error'); return }
        state.slides.splice(state.currentSlide, 1); if (state.currentSlide >= state.slides.length) state.currentSlide = state.slides.length - 1;
        renderCurrentSlide(); renderSlidesList(); broadcastSlides()
    });
    $('btn-slide-fullscreen')?.addEventListener('click', () => {
        const wrapper = $('slide-canvas-wrapper');
        if (wrapper.requestFullscreen) wrapper.requestFullscreen(); else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen()
    });
    // Drawing on slides
    const sc = $('slide-canvas'); if (!sc) return;
    let slideDrawing = false, slidePath = [];
    sc.addEventListener('mousedown', e => {
        if (!canEdit()) return; slideDrawing = true; const rect = sc.getBoundingClientRect();
        slidePath = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }]
    });
    sc.addEventListener('mousemove', e => {
        if (!slideDrawing) return; const rect = sc.getBoundingClientRect(); slidePath.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        renderCurrentSlide(); slideCtx.beginPath(); slideCtx.strokeStyle = state.canvas.color; slideCtx.lineWidth = state.canvas.strokeWidth; slideCtx.lineCap = 'round';
        slideCtx.moveTo(slidePath[0].x, slidePath[0].y); for (let i = 1; i < slidePath.length; i++)slideCtx.lineTo(slidePath[i].x, slidePath[i].y); slideCtx.stroke()
    });
    sc.addEventListener('mouseup', () => {
        if (!slideDrawing || slidePath.length < 2) return; slideDrawing = false;
        const slide = state.slides[state.currentSlide]; if (slide) slide.elements.push({ type: 'path', points: [...slidePath], color: state.canvas.color, strokeWidth: state.canvas.strokeWidth, id: genId() });
        slidePath = []; renderCurrentSlide(); broadcastSlides()
    });
    sc.addEventListener('mouseleave', () => { slideDrawing = false; slidePath = [] })
}
function broadcastSlides() { broadcast({ type: 'slide-update', slides: state.slides, currentSlide: state.currentSlide }) }

// ─── MONACO ───
function initMonaco() {
    require(['vs/editor/editor.main'], function () {
        state.monacoReady = true;
        monaco.editor.defineTheme('vsat-dark', {
            base: 'vs-dark', inherit: true,
            rules: [{ token: 'comment', foreground: '6a737d', fontStyle: 'italic' }, { token: 'keyword', foreground: 'f97583' }, { token: 'string', foreground: '9ecbff' }, { token: 'number', foreground: '79b8ff' }],
            colors: {
                'editor.background': '#0a0e17', 'editor.foreground': '#e8ecf4', 'editor.lineHighlightBackground': '#151b2b',
                'editorLineNumber.foreground': '#3a4555', 'editorLineNumber.activeForeground': '#7d8590', 'editor.selectionBackground': '#1f6feb55',
                'editorCursor.foreground': '#a78bfa', 'editorIndentGuide.background': '#1c2438', 'editorGutter.background': '#0a0e17',
                'scrollbarSlider.background': '#ffffff08', 'scrollbarSlider.hoverBackground': '#ffffff14'
            }
        });
        monaco.editor.setTheme('vsat-dark');
        state.editor = monaco.editor.create($('monaco-container'), {
            value: '', language: 'plaintext', theme: 'vsat-dark', fontSize: 14,
            fontFamily: "'JetBrains Mono','Fira Code',monospace", fontLigatures: true, lineNumbers: 'on', minimap: { enabled: true }, wordWrap: 'off',
            scrollBeyondLastLine: false, automaticLayout: true, readOnly: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
            smoothScrolling: true, renderWhitespace: 'selection', bracketPairColorization: { enabled: true }, padding: { top: 12, bottom: 12 }
        });
        state.editor.onDidChangeModelContent(() => {
            if (state.suppressChange || !state.activeFile || !canEdit()) return;
            const content = state.editor.getValue(); state.workspace[state.activeFile].content = content; state.workspace[state.activeFile].modified = true;
            renderFileTree(); renderTabs(); clearTimeout(state.syncDebounce);
            state.syncDebounce = setTimeout(() => {
                if (!state.activeFile) return; state.localVersion[state.activeFile] = (state.localVersion[state.activeFile] || 0) + 1;
                state.workspace[state.activeFile].version = state.localVersion[state.activeFile]; state.workspace[state.activeFile].modified = false;
                renderFileTree(); renderTabs(); broadcast({ type: 'sync', filename: state.activeFile, content, version: state.localVersion[state.activeFile] });
                $('status-sync').textContent = 'Synced ✓'; setTimeout(() => { $('status-sync').textContent = 'Ready' }, 2000)
            }, 120)
        });
        state.editor.onDidChangeCursorPosition(e => {
            const { lineNumber, column } = e.position; $('status-cursor').textContent = `Ln ${lineNumber}, Col ${column}`;
            clearTimeout(state.cursorDebounce); state.cursorDebounce = setTimeout(() => { broadcast({ type: 'cursor', filename: state.activeFile, pos: { lineNumber, column } }) }, 80)
        });
        const first = state.activeFile && state.workspace[state.activeFile] ? state.activeFile : Object.keys(state.workspace)[0] || null;
        if (first) switchFile(first); else { $('editor-empty-state')?.classList.remove('hidden'); $('monaco-container').classList.add('hidden') }
    })
}

// ─── ROOM FLOWS ───
async function createRoom(files) {
    state.role = 'owner'; state.roomCode = generateCode(); state.workspace = {}; state.localVersion = {};
    files.forEach(f => addFileToWorkspace(f.name, f.content)); if (!Object.keys(state.workspace).length) addFileToWorkspace('main.js', '// Welcome to VSAT!\n');
    $('room-code-display').textContent = state.roomCode; $('share-link-input').value = buildShareURL(state.roomCode);
    updateRoleBadge(); applySettingsToUI();
    initPeer(state.roomCode, () => {
        state.peer.on('connection', conn => setupConn(conn)); showScreen('screen-workspace');
        updateStatus('connecting', 'Waiting for peers…'); updatePeersUI(); initMonaco(); setupCanvas(); setupSlides(); renderSlidesList();
        toast(`Room created! Code: ${state.roomCode}`, 'success', 6000)
    })
}

function joinRoom(code) {
    state.role = 'viewer'; state.roomCode = code.toUpperCase();
    const guestId = 'G' + generateCode() + Date.now().toString(36).toUpperCase().slice(-4);
    $('room-code-display').textContent = state.roomCode; $('join-status')?.classList.remove('hidden');
    $('join-status-text').textContent = 'Connecting…';
    initPeer(guestId, () => {
        const conn = state.peer.connect(state.roomCode, { reliable: true }); setupConn(conn);
        const timeout = setTimeout(() => { if (!conn.open) { toast('Could not connect.', 'error', 6000); $('join-status')?.classList.add('hidden'); $('btn-join').disabled = false } }, 14000);
        conn.on('open', () => {
            clearTimeout(timeout); conn.send({ type: 'peer-info', name: state.myName, color: state.myColor });
            $('join-status')?.classList.add('hidden'); showScreen('screen-workspace'); updateStatus('connecting', 'Loading…');
            updateRoleBadge(); applySettingsToUI(); initMonaco(); setupCanvas(); setupSlides(); renderSlidesList()
        })
    })
}

function leaveRoom(confirm = true) {
    const doLeave = () => {
        if (state.peer) try { state.peer.destroy() } catch (e) { } state.peer = null;
        state.conns = {}; state.peers = {}; state.workspace = {}; state.localVersion = {}; state.activeFile = null; state.role = null; state.roomCode = null;
        state.chat = []; state.decorations = {}; state.canvas.elements = []; state.slides = [{ id: 'slide-1', elements: [], background: '#1a1f2e' }]; state.currentSlide = 0; state.dots = [];
        if (state.editor) { state.editor.dispose(); state.editor = null; state.monacoReady = false }
        try { monaco.editor.getModels().forEach(m => m.dispose()) } catch (e) { }
        $('file-tabs').innerHTML = ''; $('file-tree').innerHTML = ''; $('peers-list').innerHTML = ''; $('chat-messages').innerHTML = '';
        showScreen('screen-landing'); updateStatus('offline', 'Offline')
    };
    if (confirm) showModal({ icon: '👋', title: 'Leave Room?', body: 'Disconnect from this session?', confirmText: 'Leave', cancelText: 'Stay', onConfirm: doLeave }); else doLeave()
}

function buildShareURL(code) { const url = new URL(location.href.split('?')[0]); url.searchParams.set('room', code); return url.toString() }
function sendChat() {
    const input = $('chat-input'); const text = input.value.trim().substring(0, SEC.MAX_CHAT_LEN); if (!text) return;
    input.value = ''; addChatMessage(state.myName, text, state.myColor, true); broadcast({ type: 'chat', text })
}

// ─── LANDING UI ───
let pendingFiles = [];
function setupLanding() {
    const dz = $('drop-zone'), fi = $('file-input'); if (!dz || !fi) return;
    dz.addEventListener('click', () => fi.click()); dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over') });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); addPending([...e.dataTransfer.files]) });
    fi.addEventListener('change', () => { addPending([...fi.files]); fi.value = '' });

    function addPending(files) {
        files.forEach(f => {
            if (f.size > SEC.MAX_FILE_SIZE) { toast(`${f.name}: too large`, 'error'); return }
            if (pendingFiles.length >= SEC.MAX_FILES) { toast('Too many files', 'error'); return } if (!pendingFiles.find(p => p.name === f.name)) pendingFiles.push(f)
        }); renderPending()
    }
    function renderPending() {
        const list = $('selected-files-list'); if (!pendingFiles.length) { list.classList.add('hidden'); return }
        list.classList.remove('hidden'); list.innerHTML = '';
        pendingFiles.forEach((f, i) => {
            const ext = f.name.split('.').pop().substring(0, 4); const el = document.createElement('div'); el.className = 'selected-file-item';
            el.innerHTML = `<span class="sf-ext">${escapeHtml(ext)}</span><span class="sf-name">${escapeHtml(f.name)}</span><span class="sf-size">${formatBytes(f.size)}</span><button class="sf-rm">×</button>`;
            el.querySelector('.sf-rm').addEventListener('click', () => { pendingFiles.splice(i, 1); renderPending() }); list.appendChild(el)
        })
    }

    $('btn-create').addEventListener('click', async () => {
        const name = ($('display-name-create').value.trim() || 'Host').substring(0, SEC.MAX_NAME_LEN);
        state.myName = name; state.myColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
        $('btn-create').disabled = true; $('btn-create').innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Creating…';
        const loaded = await loadFiles(pendingFiles); await createRoom(loaded); $('btn-create').disabled = false; $('btn-create').textContent = 'Create Workspace'
    });

    const boxes = [...document.querySelectorAll('.code-box')];
    boxes.forEach((box, idx) => {
        box.addEventListener('input', e => {
            const v = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
            box.value = v ? v[v.length - 1] : ''; box.classList.toggle('filled', !!box.value); if (box.value && idx < 5) boxes[idx + 1].focus(); $('btn-join').disabled = getEnteredCode().length !== 6
        });
        box.addEventListener('keydown', e => {
            if (e.key === 'Backspace' && !box.value && idx > 0) { boxes[idx - 1].value = ''; boxes[idx - 1].classList.remove('filled'); boxes[idx - 1].focus(); $('btn-join').disabled = true }
            if (e.key === 'Enter' && getEnteredCode().length === 6) doJoin()
        });
        box.addEventListener('paste', e => {
            e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 6);
            boxes.forEach((b, i) => { b.value = t[i] || ''; b.classList.toggle('filled', !!b.value) }); $('btn-join').disabled = getEnteredCode().length !== 6
        })
    });

    $('btn-join').addEventListener('click', doJoin);
    function doJoin() {
        const code = getEnteredCode(); if (code.length !== 6) return;
        const name = ($('display-name-join').value.trim() || 'Guest').substring(0, SEC.MAX_NAME_LEN);
        state.myName = name; state.myColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)]; $('btn-join').disabled = true; joinRoom(code)
    }

    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam?.length === 6) {
        const upper = roomParam.toUpperCase(); boxes.forEach((b, i) => { b.value = upper[i] || ''; b.classList.toggle('filled', !!b.value) });
        $('btn-join').disabled = false; setTimeout(() => $('card-join')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)
    }
}

function getEnteredCode() { return [...document.querySelectorAll('.code-box')].map(b => b.value).join('') }

// ─── IDE EVENTS ───
function setupIDE() {
    $('btn-leave-room')?.addEventListener('click', () => leaveRoom(true));
    $('btn-copy-code')?.addEventListener('click', () => { navigator.clipboard.writeText(state.roomCode || '').then(() => toast('Code copied!', 'success')).catch(() => toast('Copied!', 'success')) });
    $('btn-copy-link')?.addEventListener('click', () => { navigator.clipboard.writeText($('share-link-input').value).then(() => toast('Link copied!', 'success')).catch(() => { }) });
    $('btn-toggle-right')?.addEventListener('click', () => {
        state.rightPanelOpen = !state.rightPanelOpen; $('right-panel').classList.toggle('collapsed', !state.rightPanelOpen);
        if (state.editor) setTimeout(() => state.editor.layout(), 210)
    });

    document.querySelectorAll('.rpanel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.rpanel-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.rpanel-content').forEach(c => { c.classList.remove('active'); c.classList.add('hidden') });
            tab.classList.add('active'); const el = $(tab.dataset.tab); if (el) { el.classList.remove('hidden'); el.classList.add('active') }
        })
    });

    document.querySelectorAll('#activity-bar .activity-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const panelId = btn.dataset.panel; const already = btn.classList.contains('active');
            document.querySelectorAll('#activity-bar .activity-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
            if (!already && panelId) { btn.classList.add('active'); $(panelId)?.classList.add('active'); $('left-sidebar').style.width = 'var(--sidebar-w)' }
            else { $('left-sidebar').style.width = '0' } if (state.editor) setTimeout(() => state.editor.layout(), 210)
        })
    });

    // View tabs
    document.querySelectorAll('.view-tab').forEach(tab => { tab.addEventListener('click', () => switchView(tab.dataset.view)) });

    $('btn-upload-file')?.addEventListener('click', () => $('file-input-sidebar').click());
    $('file-input-sidebar')?.addEventListener('change', async e => {
        const loaded = await loadFiles([...e.target.files]);
        loaded.forEach(f => { const name = addFileToWorkspace(f.name, f.content); if (name) switchFile(name) });
        if (state.role === 'owner') Object.values(state.conns).forEach(conn => { if (conn.open) sendWorkspace(conn) }); e.target.value = ''
    });

    $('btn-new-file')?.addEventListener('click', () => { $('newfile-backdrop').classList.remove('hidden'); $('newfile-input').value = ''; setTimeout(() => $('newfile-input').focus(), 80) });
    $('newfile-cancel')?.addEventListener('click', () => $('newfile-backdrop').classList.add('hidden'));
    $('newfile-confirm')?.addEventListener('click', () => {
        const name = safeFilename($('newfile-input').value.trim()); if (!name) { toast('Enter a filename', 'error'); return }
        if (state.workspace[name]) { toast('File exists', 'error'); return } addFileToWorkspace(name, ''); switchFile(name); $('newfile-backdrop').classList.add('hidden');
        if (state.role === 'owner') Object.values(state.conns).forEach(c => { if (c.open) sendWorkspace(c) })
    });
    $('newfile-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('newfile-confirm').click(); if (e.key === 'Escape') $('newfile-backdrop').classList.add('hidden') });

    document.addEventListener('click', () => hideContextMenu());
    $('ctx-rename')?.addEventListener('click', () => {
        const fn = state.contextTarget; hideContextMenu(); if (!fn || !canEdit()) return;
        const newName = prompt(`Rename "${fn}" to:`, fn); if (!newName || newName === fn) return; const safeName = safeFilename(newName);
        if (!safeName || state.workspace[safeName]) { toast('Invalid or duplicate', 'error'); return }
        const file = state.workspace[fn]; state.workspace[safeName] = { ...file, language: getLang(safeName) }; delete state.workspace[fn];
        if (state.activeFile === fn) state.activeFile = safeName; renderFileTree(); renderTabs(); broadcast({ type: 'file-rename', oldName: fn, newName: safeName })
    });
    $('ctx-download')?.addEventListener('click', () => { const fn = state.contextTarget; hideContextMenu(); if (fn) downloadFile(fn) });
    $('ctx-delete')?.addEventListener('click', () => {
        const fn = state.contextTarget; hideContextMenu(); if (!fn || !canEdit()) return;
        showModal({ icon: '🗑️', title: 'Delete File?', body: `Delete "${fn}"?`, confirmText: 'Delete', onConfirm: () => { removeFileFromWorkspace(fn); broadcast({ type: 'file-delete', filename: fn }) } })
    });

    $('btn-send-chat')?.addEventListener('click', sendChat); $('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat() });

    $('toggle-download')?.addEventListener('change', () => { if (!isOwner()) return; state.settings.downloadAllowed = $('toggle-download').checked; broadcast({ type: 'settings-update', settings: state.settings }) });
    $('select-default-role')?.addEventListener('change', () => { if (!isOwner()) return; state.settings.defaultRole = $('select-default-role').value; broadcast({ type: 'settings-update', settings: state.settings }) });

    let searchDeb = null; $('search-input')?.addEventListener('input', () => { clearTimeout(searchDeb); searchDeb = setTimeout(() => performSearch($('search-input').value), 300) });

    // Smooth scroll for nav links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();
            const target = document.querySelector(link.getAttribute('href')); if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
    })
}

// ─── BOOT ───
document.addEventListener('DOMContentLoaded', () => { setupLanding(); setupIDE(); updateStatus('offline', 'Offline') });
