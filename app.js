/* ═══════════════════════════════════════════════════════════════════
   CollabShare — app.js  v2  (fixed file transfer)
   Real-time P2P file sharing via PeerJS (WebRTC data channels)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 32 * 1024;   // 32 KB per chunk (safe for WebRTC data channel)
const MAX_FILE_MB = 50;          // warn user for files > 50 MB

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  peer: null,   // PeerJS Peer instance
  connections: [],     // open DataConnections
  role: null,   // 'host' | 'guest'
  roomCode: null,
  currentFile: null,   // { name, type, size, category, data: string|Uint8Array }
  mode: 'view',
  editDebounce: null,
  isTextFile: false,

  // chunk assembly per sender peer ID
  inboundChunks: {},    // { [peerId]: { meta, parts: [] } }
};

// ─── DOM helpers ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = { landing: $('screen-landing'), room: $('screen-room') };

// ─── Utilities ───────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
}
function getFileCategory(type, name) {
  const ext = name.split('.').pop().toLowerCase();
  const textExts = ['txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'xml', 'csv',
    'yaml', 'yml', 'sh', 'py', 'java', 'c', 'cpp', 'h', 'rs', 'go', 'rb', 'php', 'sql',
    'toml', 'ini', 'env', 'gitignore', 'log', 'vue', 'svelte'];
  const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'];
  if (!type || type === 'application/octet-stream') {
    if (textExts.includes(ext)) return 'text';
    if (imgExts.includes(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    return 'binary';
  }
  if (type.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript',
      'application/typescript', 'application/x-sh'].includes(type)) return 'text';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'binary';
}
function getExtLabel(name) {
  const p = name.split('.');
  return p.length > 1 ? p.pop().substring(0, 4).toUpperCase() : 'FILE';
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const icons = {
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(34,197,94,0.2)"/><path d="M9 12l2 2 4-4" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(239,68,68,0.2)"/><path d="M15 9l-6 6M9 9l6 6" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>`,
    info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(124,58,237,0.2)"/><path d="M12 8v4M12 16h.01" stroke="#a78bfa" stroke-width="2" stroke-linecap="round"/></svg>`,
  };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<div class="toast-icon">${icons[type] || icons.info}</div><span>${msg}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

// ─── Screen switching ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ─── File I/O ─────────────────────────────────────────────────────────────────
function readFileAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}
function readFileAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}

async function loadFileIntoState(file) {
  const category = getFileCategory(file.type, file.name);
  const data = category === 'text'
    ? await readFileAsText(file)
    : await readFileAsArrayBuffer(file);

  state.currentFile = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    category,
    data,
  };
}

// ─── Chunked file transfer ────────────────────────────────────────────────────
// Protocol:
//   { type:'file-start',  meta:{ name, type, size, category, totalChunks, encoding } }
//   { type:'file-chunk',  index, data: base64string|null }   (repeated)
//   { type:'file-end',    name }
//
// Text files: send as one chunk, encoding='text'
// Binary:     base64-encode each 32KB chunk

function sendFileTo(conn) {
  if (!state.currentFile || !conn.open) {
    console.warn('[CS] sendFileTo: no file or conn not open');
    return;
  }
  console.log('[CS] Sending file to', conn.peer, state.currentFile.name);

  const { name, type, size, category, data } = state.currentFile;

  if (category === 'text') {
    // Text: single chunk
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    conn.send({ type: 'file-start', meta: { name, type, size, category, totalChunks: 1, encoding: 'text' } });
    conn.send({ type: 'file-chunk', index: 0, data: text });
    conn.send({ type: 'file-end', name });
    console.log('[CS] Text file sent OK');
  } else {
    // Binary: base64 chunks
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const bytes = new Uint8Array(buf);
    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);

    conn.send({ type: 'file-start', meta: { name, type, size, category, totalChunks, encoding: 'base64' } });

    for (let i = 0; i < totalChunks; i++) {
      const slice = bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      let binary = '';
      slice.forEach(b => binary += String.fromCharCode(b));
      conn.send({ type: 'file-chunk', index: i, data: btoa(binary) });
    }

    conn.send({ type: 'file-end', name });
    console.log(`[CS] Binary file sent in ${totalChunks} chunks`);
  }
}

// Broadcast to all open connections (host → all guests; guest → host)
function broadcast(msg) {
  state.connections.filter(c => c.open).forEach(c => {
    try { c.send(msg); } catch (e) { console.error('[CS] broadcast error', e); }
  });
}

// ─── Receive / assemble ───────────────────────────────────────────────────────
function handleMessage(conn, msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {

    case 'file-start': {
      // Begin assembling
      state.inboundChunks[conn.peer] = { meta: msg.meta, parts: [] };
      console.log(`[CS] file-start: ${msg.meta.name}, ${msg.meta.totalChunks} chunks`);
      showSyncIndicator();
      break;
    }

    case 'file-chunk': {
      const inbound = state.inboundChunks[conn.peer];
      if (!inbound) { console.warn('[CS] chunk before start?'); break; }
      inbound.parts[msg.index] = msg.data;
      break;
    }

    case 'file-end': {
      const inbound = state.inboundChunks[conn.peer];
      if (!inbound) break;
      delete state.inboundChunks[conn.peer];
      assembleAndRender(inbound.meta, inbound.parts);

      // If HOST: relay to other guests (multi-peer support)
      if (state.role === 'host') {
        state.connections.filter(c => c.open && c !== conn).forEach(c => sendFileTo(c));
      }
      break;
    }

    case 'text-update': {
      receiveTextUpdate(msg.payload, conn);
      break;
    }

    case 'request-file': {
      console.log('[CS] guest requested file');
      if (state.currentFile) sendFileTo(conn);
      break;
    }

    case 'peer-joined': {
      toast('A peer joined the room!', 'info');
      updatePeersList();
      break;
    }

    case 'peer-left': {
      toast('A peer disconnected', 'info');
      updatePeersList();
      break;
    }

    default:
      console.warn('[CS] Unknown message type:', msg.type);
  }
}

function assembleAndRender(meta, parts) {
  const { name, type, size, category, encoding } = meta;
  console.log('[CS] Assembling file:', name, 'encoding:', encoding);

  let fileData;

  if (encoding === 'text') {
    fileData = parts[0] || '';
  } else {
    // Reassemble binary from base64 chunks
    const chunks = parts.map(b64 => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    });
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    chunks.forEach(c => { merged.set(c, offset); offset += c.length; });
    fileData = merged.buffer;
  }

  state.currentFile = { name, type, size, category, data: fileData };
  renderFile(state.currentFile);
  hideSyncIndicator();
  showSaveIndicator();
  toast(`📄 File received: ${name}`, 'success');
}

// ─── Text realtime sync ───────────────────────────────────────────────────────
function receiveTextUpdate(payload, fromConn) {
  if (!state.isTextFile) return;
  const editor = $('text-editor');
  const selStart = editor.selectionStart;
  const selEnd = editor.selectionEnd;
  editor.value = payload.text;
  if (state.currentFile) state.currentFile.data = payload.text;
  editor.setSelectionRange(
    Math.min(selStart, editor.value.length),
    Math.min(selEnd, editor.value.length)
  );
  showSaveIndicator();
  // Host relays to other guests
  if (state.role === 'host') {
    state.connections.filter(c => c.open && c !== fromConn).forEach(c => {
      try { c.send({ type: 'text-update', payload }); } catch (e) { }
    });
  }
}

// ─── Sync indicators ──────────────────────────────────────────────────────────
function showSyncIndicator() { $('sync-indicator').classList.remove('hidden'); $('save-indicator').classList.add('hidden'); }
function hideSyncIndicator() { $('sync-indicator').classList.add('hidden'); }
function showSaveIndicator() {
  hideSyncIndicator();
  const s = $('save-indicator');
  s.classList.remove('hidden');
  setTimeout(() => s.classList.add('hidden'), 2500);
}

// ─── Connection setup ──────────────────────────────────────────────────────────
function setupConnectionHandlers(conn) {
  conn.on('open', () => {
    console.log('[CS] Connection open with', conn.peer, '| role:', state.role);

    if (state.role === 'host') {
      // Host: proactively send the current file
      setTimeout(() => {
        if (state.currentFile) sendFileTo(conn);
      }, 200); // small delay ensures data handler is wired on guest side
    } else {
      // Guest: notify + request file
      conn.send({ type: 'peer-joined', payload: { label: 'Guest' } });
      // Also request explicitly after a tick (belt + suspenders)
      setTimeout(() => conn.send({ type: 'request-file' }), 300);

      // Switch to room screen now that we're connected
      $('join-status').classList.add('hidden');
      showScreen('room');
      updateConnectionStatus('connecting', 'Waiting for file…');
    }

    updatePeersList();
  });

  conn.on('data', data => {
    console.log('[CS] data received type:', data?.type);
    handleMessage(conn, data);
  });

  conn.on('close', () => {
    console.log('[CS] conn closed with', conn.peer);
    state.connections = state.connections.filter(c => c !== conn);
    delete state.inboundChunks[conn.peer];
    updatePeersList();
    const any = state.connections.some(c => c.open);
    updateConnectionStatus(any ? 'online' : 'connecting', any ? 'Connected' : 'Waiting for peers…');
    toast('A peer disconnected', 'info');
  });

  conn.on('error', err => {
    console.error('[CS] conn error', err);
    toast('Connection error: ' + (err.message || err.type), 'error');
  });
}

function updateConnectionStatus(type, text) {
  const dot = $('conn-dot');
  const span = $('conn-status');
  dot.className = 'status-dot ' + type;
  span.textContent = text;
}

// ─── PeerJS init ──────────────────────────────────────────────────────────────
// NOTE: We do NOT override serialization. PeerJS default ('binary') supports
// both JS objects and large data with automatic chunking in the transport layer.
// Our own chunking protocol handles the application-level file splitting.

function initPeer(id, onReady) {
  destroyPeer();
  console.log('[CS] Creating peer with ID:', id);

  const peer = new Peer(id, {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
    },
  });

  state.peer = peer;

  peer.on('open', peerId => {
    console.log('[CS] Peer open, ID:', peerId);
    onReady();
  });

  peer.on('error', err => {
    console.error('[CS] Peer error:', err.type, err.message);
    let msg = 'Connection failed';
    if (err.type === 'peer-unavailable') msg = 'Room not found. Check the code and try again.';
    else if (err.type === 'network') msg = 'Network error. Check your internet connection.';
    else if (err.type === 'unavailable-id') msg = 'Room code taken. Please try creating again.';
    toast(msg, 'error', 6000);
    $('join-status').classList.add('hidden');
    $('btn-join').disabled = false;
    updateConnectionStatus('error', 'Failed');
  });

  peer.on('disconnected', () => {
    console.warn('[CS] Peer disconnected, reconnecting…');
    updateConnectionStatus('connecting', 'Reconnecting…');
    try { peer.reconnect(); } catch (e) { }
  });
}

function destroyPeer() {
  if (state.peer) { try { state.peer.destroy(); } catch (e) { } state.peer = null; }
  state.connections = [];
  state.inboundChunks = {};
}

// ─── HOST flow ────────────────────────────────────────────────────────────────
async function createRoom(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    // Show warning but proceed
    toast(`⚠️ Large file (${formatBytes(file.size)}) — transfer may be slow`, 'info', 5000);
  }

  state.role = 'host';
  state.roomCode = generateCode();
  $('room-code-display').textContent = state.roomCode;
  $('share-link-input').value = buildShareURL(state.roomCode);
  updatePeersLabel();

  await loadFileIntoState(file);

  initPeer(state.roomCode, () => {
    state.peer.on('connection', conn => {
      console.log('[CS] Incoming connection from:', conn.peer);
      state.connections.push(conn);
      setupConnectionHandlers(conn);
    });

    renderFile(state.currentFile);
    showScreen('room');
    updateConnectionStatus('connecting', 'Waiting for peers…');
    updatePeersList();
    toast(`Room created! Code: ${state.roomCode}`, 'success', 6000);
  });
}

// ─── GUEST flow ───────────────────────────────────────────────────────────────
function joinRoom(code) {
  state.role = 'guest';
  state.roomCode = code.toUpperCase();
  $('room-code-display').textContent = state.roomCode;
  $('share-link-input').value = buildShareURL(state.roomCode);
  updatePeersLabel();

  const guestId = 'G-' + generateCode() + '-' + Date.now().toString(36).toUpperCase();
  $('join-status').classList.remove('hidden');
  $('join-status-text').textContent = 'Initializing…';

  initPeer(guestId, () => {
    $('join-status-text').textContent = 'Connecting to host…';
    console.log('[CS] Guest connecting to room:', state.roomCode);

    // *** KEY FIX: no serialization override — use PeerJS default binary mode ***
    const conn = state.peer.connect(state.roomCode, {
      reliable: true,
    });

    state.connections = [conn];
    setupConnectionHandlers(conn);

    const timeout = setTimeout(() => {
      if (!conn.open) {
        toast('Could not connect — is the code correct?', 'error', 6000);
        $('join-status').classList.add('hidden');
        $('btn-join').disabled = false;
        destroyPeer();
      }
    }, 15000);

    conn.on('open', () => clearTimeout(timeout));
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function updatePeersList() {
  const list = $('peers-list');
  const count = state.connections.filter(c => c.open).length + 1;
  $('peer-count').textContent = count + ' peer' + (count !== 1 ? 's' : '');
  updatePeersLabel();

  list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', `
    <div class="peer-item self">
      <div class="peer-avatar">You</div>
      <span class="peer-label">You (${state.role === 'host' ? 'Host' : 'Guest'})</span>
    </div>
  `);
  state.connections.filter(c => c.open).forEach((_, i) => {
    list.insertAdjacentHTML('beforeend', `
      <div class="peer-item">
        <div class="peer-avatar" style="background:linear-gradient(135deg,#2563eb,#06b6d4)">P${i + 1}</div>
        <span class="peer-label">Peer ${i + 1}</span>
      </div>
    `);
  });
}
function updatePeersLabel() {
  const dot = document.querySelector('.peer-dot');
  if (dot) dot.className = 'peer-dot ' + (state.connections.some(c => c.open) ? 'active' : '');
}

// ─── File viewer ──────────────────────────────────────────────────────────────
let currentObjectURL = null;

function renderFile(fileObj) {
  const { name, type, size, data, category } = fileObj;

  if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }

  $('sidebar-file-name').textContent = name;
  $('sidebar-file-size').textContent = formatBytes(size);
  $('sidebar-file-icon').innerHTML = getFileIconSVG(category);
  $('viewer-file-label').textContent = name;
  $('binary-file-name').textContent = name;
  $('binary-file-desc').textContent = `${type || 'Unknown'} · ${formatBytes(size)}`;

  ['text-viewer', 'image-viewer', 'pdf-viewer', 'binary-viewer', 'viewer-empty']
    .forEach(id => $(id).classList.add('hidden'));

  state.isTextFile = (category === 'text');
  $('tab-edit').style.opacity = state.isTextFile ? '1' : '0.35';
  $('tab-edit').style.pointerEvents = state.isTextFile ? 'auto' : 'none';

  if (category === 'text') {
    $('text-viewer').classList.remove('hidden');
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    $('text-editor').value = text;
    applyViewMode(state.mode);

  } else if (category === 'image') {
    $('image-viewer').classList.remove('hidden');
    const blob = data instanceof ArrayBuffer ? new Blob([data], { type }) : new Blob([data]);
    currentObjectURL = URL.createObjectURL(blob);
    $('image-preview').src = currentObjectURL;

  } else if (category === 'pdf') {
    $('pdf-viewer').classList.remove('hidden');
    const blob = new Blob([data], { type: 'application/pdf' });
    currentObjectURL = URL.createObjectURL(blob);
    $('pdf-embed').src = currentObjectURL;

  } else {
    $('binary-viewer').classList.remove('hidden');
  }

  updateConnectionStatus('online', 'Connected');
}

function getFileIconSVG(cat) {
  const m = {
    text: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/><line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    image: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><polyline points="21 15 16 10 5 21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    pdf: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/><line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    binary: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/></svg>`,
  };
  return m[cat] || m.binary;
}

function applyViewMode(mode) {
  state.mode = mode;
  const e = $('text-editor');
  $('tab-view').classList.toggle('active', mode === 'view');
  $('tab-edit').classList.toggle('active', mode === 'edit');
  e.readOnly = (mode === 'view');
  e.style.cursor = mode === 'edit' ? 'text' : 'default';
  if (mode === 'edit') e.focus();
}

// ─── Download ─────────────────────────────────────────────────────────────────
function downloadCurrentFile() {
  if (!state.currentFile) return toast('No file to download', 'error');
  const { name, type, data, category } = state.currentFile;
  const text = category === 'text' && typeof data === 'string' ? data : null;
  const blob = text ? new Blob([text], { type: type || 'text/plain' }) : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Download started!', 'success');
}

// ─── Share URL ────────────────────────────────────────────────────────────────
function buildShareURL(code) {
  const url = new URL(location.href.split('?')[0]);
  url.searchParams.set('room', code);
  return url.toString();
}
function checkURLParams() {
  const code = new URLSearchParams(location.search).get('room');
  if (code && code.length === 6) {
    const upper = code.toUpperCase();
    [...document.querySelectorAll('.code-box')].forEach((b, i) => {
      b.value = upper[i] || '';
      b.classList.toggle('filled', !!b.value);
    });
    validateJoinButton();
    setTimeout(() => {
      $('card-join').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('code-0').focus();
    }, 400);
  }
}

// ─── Landing UI ───────────────────────────────────────────────────────────────
let pendingFile = null;

function setupLanding() {
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const btnCreate = $('btn-create');
  const fileSelEl = $('file-selected');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) setSelectedFile(f);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) setSelectedFile(fileInput.files[0]); });

  function setSelectedFile(f) {
    pendingFile = f;
    $('file-name-display').textContent = f.name;
    $('file-size-display').textContent = formatBytes(f.size);
    $('file-thumb').textContent = getExtLabel(f.name);
    fileSelEl.classList.remove('hidden');
    dropZone.classList.add('hidden');
    btnCreate.disabled = false;
  }

  $('btn-clear-file').addEventListener('click', () => {
    pendingFile = null; fileInput.value = '';
    fileSelEl.classList.add('hidden');
    dropZone.classList.remove('hidden');
    btnCreate.disabled = true;
  });

  btnCreate.addEventListener('click', async () => {
    if (!pendingFile) return;
    btnCreate.disabled = true;
    btnCreate.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px;flex-shrink:0"></div> Creating room…`;
    try {
      await createRoom(pendingFile);
    } catch (e) {
      console.error(e);
      toast('Error: ' + e.message, 'error');
      btnCreate.disabled = false;
      btnCreate.textContent = 'Create Room & Share';
    }
  });

  // Code boxes
  const boxes = [...document.querySelectorAll('.code-box')];
  boxes.forEach((box, idx) => {
    box.addEventListener('input', e => {
      const val = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      box.value = val ? val[val.length - 1] : '';
      box.classList.toggle('filled', !!box.value);
      if (box.value && idx < 5) boxes[idx + 1].focus();
      validateJoinButton();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && idx > 0) {
        boxes[idx - 1].value = '';
        boxes[idx - 1].classList.remove('filled');
        boxes[idx - 1].focus();
        validateJoinButton();
      }
      if (e.key === 'Enter') { const c = getEnteredCode(); if (c.length === 6) triggerJoin(c); }
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text')
        .replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 6);
      boxes.forEach((b, i) => { b.value = t[i] || ''; b.classList.toggle('filled', !!b.value); });
      validateJoinButton();
      if (t.length === 6) boxes[5].focus();
    });
  });

  $('btn-join').addEventListener('click', () => {
    const c = getEnteredCode();
    if (c.length === 6) triggerJoin(c);
  });
}

function getEnteredCode() {
  return [...document.querySelectorAll('.code-box')].map(b => b.value).join('');
}
function validateJoinButton() {
  $('btn-join').disabled = getEnteredCode().length !== 6;
}
function triggerJoin(code) {
  $('btn-join').disabled = true;
  joinRoom(code);
}

// ─── Room UI ──────────────────────────────────────────────────────────────────
function setupRoom() {
  $('btn-copy-code').addEventListener('click', () =>
    navigator.clipboard.writeText(state.roomCode).then(() => toast('Code copied!', 'success'))
  );
  $('btn-copy-link').addEventListener('click', () =>
    navigator.clipboard.writeText($('share-link-input').value).then(() => toast('Link copied!', 'success'))
  );

  $('btn-download').addEventListener('click', downloadCurrentFile);
  $('btn-download-binary').addEventListener('click', downloadCurrentFile);

  const fileInputRoom = $('file-input-room');
  $('btn-change-file').addEventListener('click', () => fileInputRoom.click());
  fileInputRoom.addEventListener('change', async () => {
    const f = fileInputRoom.files[0];
    if (!f) return;
    showSyncIndicator();
    await loadFileIntoState(f);
    renderFile(state.currentFile);
    state.connections.filter(c => c.open).forEach(c => sendFileTo(c));
    showSaveIndicator();
    toast(`File updated: ${f.name}`, 'success');
    fileInputRoom.value = '';
  });

  $('btn-leave').addEventListener('click', () => {
    showModal({
      icon: '👋', title: 'Leave Room?',
      body: 'You will disconnect from this session.',
      confirmText: 'Leave', cancelText: 'Stay',
      onConfirm: () => {
        broadcast({ type: 'peer-left', payload: {} });
        destroyPeer();
        state.currentFile = null; state.roomCode = null; state.role = null;
        ['text-viewer', 'image-viewer', 'pdf-viewer', 'binary-viewer'].forEach(id => $(id).classList.add('hidden'));
        $('viewer-empty').classList.remove('hidden');
        $('sidebar-file-name').textContent = 'No file';
        $('sidebar-file-size').textContent = '—';
        $('viewer-file-label').textContent = 'No file loaded';
        showScreen('landing');
        toast('You left the room', 'info');
      },
    });
  });

  $('tab-view').addEventListener('click', () => applyViewMode('view'));
  $('tab-edit').addEventListener('click', () => { if (state.isTextFile) applyViewMode('edit'); });

  // Real-time text sync on edit
  $('text-editor').addEventListener('input', () => {
    if (state.mode !== 'edit') return;
    const text = $('text-editor').value;
    if (state.currentFile) state.currentFile.data = text;
    clearTimeout(state.editDebounce);
    state.editDebounce = setTimeout(() => {
      broadcast({ type: 'text-update', payload: { text } });
      showSaveIndicator();
    }, 80);
  });
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal({ icon = '', title = '', body = '', confirmText = 'OK', cancelText = 'Cancel', onConfirm }) {
  $('modal-icon').textContent = icon;
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal-confirm').textContent = confirmText;
  $('modal-cancel').textContent = cancelText;
  $('modal-backdrop').classList.remove('hidden');
  const close = () => $('modal-backdrop').classList.add('hidden');
  $('modal-confirm').onclick = () => { close(); onConfirm?.(); };
  $('modal-cancel').onclick = close;
  $('modal-backdrop').onclick = e => { if (e.target === $('modal-backdrop')) close(); };
}

// ─── Host/guest UI guard ──────────────────────────────────────────────────────
function setupHostGuards() {
  new MutationObserver(() => {
    if (screens.room.classList.contains('active')) {
      $('btn-change-file').style.display = state.role === 'host' ? '' : 'none';
    }
  }).observe(screens.room, { attributes: true, attributeFilter: ['class'] });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  setupLanding();
  setupRoom();
  setupHostGuards();
  checkURLParams();
}

document.addEventListener('DOMContentLoaded', init);
