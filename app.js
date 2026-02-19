/* ═══════════════════════════════════════════════════════════════════
   CollabShare — app.js
   Real-time P2P file sharing via PeerJS (WebRTC data channels)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  peer: null,           // PeerJS peer instance
  connections: [],      // active DataConnections (host) or [single conn] (guest)
  role: null,           // 'host' | 'guest'
  roomCode: null,       // 6-char room code
  currentFile: null,    // { name, type, size, data: ArrayBuffer|string }
  mode: 'view',         // 'view' | 'edit'
  editDebounce: null,
  isTextFile: false,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = {
  landing: $('screen-landing'),
  room:    $('screen-room'),
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1048576)     return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824)  return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

function getFileCategory(type, name) {
  if (!type) {
    const ext = name.split('.').pop().toLowerCase();
    if (['txt','md','js','ts','html','css','json','xml','csv','yaml','yml','sh','py','java','c','cpp','h','rs','go','rb','php','sql'].includes(ext)) return 'text';
    if (['png','jpg','jpeg','gif','svg','webp','bmp','ico','avif'].includes(ext)) return 'image';
    if (['pdf'].includes(ext)) return 'pdf';
    return 'binary';
  }
  if (type.startsWith('text/') || ['application/json','application/xml','application/javascript','application/typescript','application/x-sh'].includes(type)) return 'text';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'binary';
}

function getExtLabel(name) {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().substring(0,4).toUpperCase() : 'FILE';
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function toast(message, type = 'info', duration = 3500) {
  const container = $('toast-container');
  const icons = {
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(34,197,94,0.2)"/><path d="M9 12l2 2 4-4" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(239,68,68,0.2)"/><path d="M15 9l-6 6M9 9l6 6" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>`,
    info:    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="rgba(124,58,237,0.2)"/><path d="M12 8v4M12 16h.01" stroke="#a78bfa" stroke-width="2" stroke-linecap="round"/></svg>`,
  };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<div class="toast-icon">${icons[type]||icons.info}</div><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

// ─── Switch screens ──────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ─── File reading ─────────────────────────────────────────────────────────────
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// ─── Render a file into the viewer ───────────────────────────────────────────
let currentObjectURL = null;

function renderFile(fileObj) {
  // fileObj = { name, type, size, data: ArrayBuffer|string, category }
  const { name, type, size, data, category } = fileObj;

  // Cleanup old object URL
  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = null;
  }

  // Update sidebar
  $('sidebar-file-name').textContent = name;
  $('sidebar-file-size').textContent = formatBytes(size);
  $('sidebar-file-icon').innerHTML = getFileIconSVG(category);
  $('viewer-file-label').textContent = name;

  // Update binary-viewer filename
  $('binary-file-name').textContent = name;
  $('binary-file-desc').textContent = `${type || 'Unknown type'} · ${formatBytes(size)}`;

  // Hide all viewers
  ['text-viewer','image-viewer','pdf-viewer','binary-viewer','viewer-empty'].forEach(id =>
    $(id).classList.add('hidden')
  );

  state.isTextFile = (category === 'text');
  $('tab-edit').style.opacity = state.isTextFile ? '1' : '0.35';
  $('tab-edit').style.pointerEvents = state.isTextFile ? 'auto' : 'none';

  if (category === 'text') {
    $('text-viewer').classList.remove('hidden');
    const editor = $('text-editor');
    editor.value = typeof data === 'string' ? data : new TextDecoder().decode(data);
    applyViewMode(state.mode);

  } else if (category === 'image') {
    $('image-viewer').classList.remove('hidden');
    const blob = data instanceof ArrayBuffer ? new Blob([data], { type }) : new Blob([data], { type });
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
}

function getFileIconSVG(category) {
  const icons = {
    text:   `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/><line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="10 9 9 9 8 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    image:  `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><polyline points="21 15 16 10 5 21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    pdf:    `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><path d="M9 13h2a2 2 0 000-4H9v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 13h1.5a1.5 1.5 0 010 3H15V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    binary: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/></svg>`,
  };
  return icons[category] || icons.binary;
}

// ─── View / Edit mode ─────────────────────────────────────────────────────────
function applyViewMode(mode) {
  state.mode = mode;
  const editor = $('text-editor');
  const tabView = $('tab-view');
  const tabEdit = $('tab-edit');

  tabView.classList.toggle('active', mode === 'view');
  tabEdit.classList.toggle('active', mode === 'edit');

  if (mode === 'view') {
    editor.readOnly = true;
    editor.style.cursor = 'default';
  } else {
    editor.readOnly = false;
    editor.style.cursor = 'text';
    editor.focus();
  }
}

// ─── Broadcast helpers ───────────────────────────────────────────────────────
function broadcast(message) {
  // Host broadcasts to all connected peers
  // Guest sends to host
  const conns = state.connections.filter(c => c.open);
  conns.forEach(c => {
    try { c.send(message); } catch(e) {}
  });
}

// ─── Handle incoming messages ─────────────────────────────────────────────────
function handleMessage(conn, msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'file-meta':
      // Incoming file metadata + data from host
      receiveFile(msg.payload);
      break;

    case 'text-update':
      // Real-time text edit from a peer
      receiveTextUpdate(msg.payload, conn);
      break;

    case 'request-file':
      // Guest requesting current file
      if (state.currentFile) sendFileTo(conn);
      break;

    case 'peer-joined':
      // Notification that someone joined (host receives this)
      toast(`${msg.payload.label} joined the room`, 'info');
      updatePeersList();
      break;

    case 'peer-left':
      toast(`A peer disconnected`, 'info');
      updatePeersList();
      break;
  }
}

// ─── File transfer ────────────────────────────────────────────────────────────
function fileToTransferPayload(fileObj) {
  // We need to convert ArrayBuffer to base64 for JSON transport
  if (fileObj.data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(fileObj.data);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return {
      name: fileObj.name,
      type: fileObj.type,
      size: fileObj.size,
      category: fileObj.category,
      encoding: 'base64',
      data: btoa(binary),
    };
  }
  return {
    name: fileObj.name,
    type: fileObj.type,
    size: fileObj.size,
    category: fileObj.category,
    encoding: 'text',
    data: fileObj.data,
  };
}

function payloadToFileObj(payload) {
  let data;
  if (payload.encoding === 'base64') {
    const binary = atob(payload.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    data = bytes.buffer;
  } else {
    data = payload.data;
  }
  return { name: payload.name, type: payload.type, size: payload.size, category: payload.category, data };
}

function sendFileTo(conn) {
  if (!state.currentFile) return;
  showSyncIndicator();
  const payload = fileToTransferPayload(state.currentFile);
  try {
    conn.send({ type: 'file-meta', payload });
  } catch(e) {
    console.error('sendFileTo error', e);
  }
  hideSyncIndicator();
}

function receiveFile(payload) {
  const fileObj = payloadToFileObj(payload);
  state.currentFile = fileObj;
  renderFile(fileObj);
  showSaveIndicator();
  toast(`File "${fileObj.name}" received ✓`, 'success');
}

// ─── Text sync ────────────────────────────────────────────────────────────────
function receiveTextUpdate(payload, fromConn) {
  if (!state.isTextFile) return;
  const editor = $('text-editor');
  // Preserve cursor position
  const selStart = editor.selectionStart;
  const selEnd   = editor.selectionEnd;
  const wasAtEnd = selStart === editor.value.length;

  editor.value = payload.text;
  if (state.currentFile) state.currentFile.data = payload.text;

  // Restore cursor
  if (!wasAtEnd) {
    editor.setSelectionRange(
      Math.min(selStart, editor.value.length),
      Math.min(selEnd,   editor.value.length)
    );
  }

  showSaveIndicator();

  // If host, re-broadcast to all OTHER connections (relay)
  if (state.role === 'host') {
    state.connections
      .filter(c => c.open && c !== fromConn)
      .forEach(c => { try { c.send({ type: 'text-update', payload }); } catch(e) {} });
  }
}

// ─── Sync indicators ──────────────────────────────────────────────────────────
function showSyncIndicator() {
  $('sync-indicator').classList.remove('hidden');
  $('save-indicator').classList.add('hidden');
}
function hideSyncIndicator() { $('sync-indicator').classList.add('hidden'); }
function showSaveIndicator() {
  hideSyncIndicator();
  const si = $('save-indicator');
  si.classList.remove('hidden');
  setTimeout(() => si.classList.add('hidden'), 2000);
}

// ─── Peers UI ──────────────────────────────────────────────────────────────────
function updatePeersList() {
  const list = $('peers-list');
  const count = state.connections.filter(c => c.open).length + 1; // +1 for self
  $('peer-count').textContent = count + ' peer' + (count !== 1 ? 's' : '');

  list.innerHTML = '';
  // Self
  const selfItem = document.createElement('div');
  selfItem.className = 'peer-item self';
  selfItem.innerHTML = `
    <div class="peer-avatar">You</div>
    <span class="peer-label">You (${state.role === 'host' ? 'Host' : 'Guest'})</span>
  `;
  list.appendChild(selfItem);

  // Connected peers
  state.connections.filter(c => c.open).forEach((conn, i) => {
    const item = document.createElement('div');
    item.className = 'peer-item';
    const initials = `P${i+1}`;
    item.innerHTML = `
      <div class="peer-avatar" style="background:linear-gradient(135deg,#2563eb,#06b6d4)">${initials}</div>
      <span class="peer-label">Peer ${i+1}</span>
    `;
    list.appendChild(item);
  });
}

// ─── Connection setup ──────────────────────────────────────────────────────────
function setupConnectionHandlers(conn) {
  conn.on('open', () => {
    console.log('[CollabShare] Connection opened:', conn.peer);

    if (state.role === 'host') {
      // Send current file to new guest
      if (state.currentFile) sendFileTo(conn);
      // Notify other peers (optional)
    } else {
      // Guest: notify host we joined
      conn.send({ type: 'peer-joined', payload: { label: 'Guest' } });
      // Request file from host
      conn.send({ type: 'request-file' });
    }

    updateConnectionStatus('online', 'Connected');
    updatePeersList();
    toast(state.role === 'host' ? 'A peer joined the room!' : 'Connected to room!', 'success');
  });

  conn.on('data', data => {
    handleMessage(conn, data);
  });

  conn.on('close', () => {
    state.connections = state.connections.filter(c => c !== conn);
    updatePeersList();
    updateConnectionStatus(state.connections.length > 0 ? 'online' : 'connecting',
                           state.connections.length > 0 ? 'Connected' : 'Waiting for peers…');
    toast('A peer disconnected', 'info');
  });

  conn.on('error', err => {
    console.error('[CollabShare] Connection error:', err);
    toast('Connection error: ' + err.message, 'error');
  });
}

function updateConnectionStatus(type, text) {
  const dot  = $('conn-dot');
  const span = $('conn-status');
  dot.className = 'status-dot ' + type;
  span.textContent = text;
}

// ─── HOST FLOW ────────────────────────────────────────────────────────────────
async function createRoom(file) {
  state.role = 'host';
  state.roomCode = generateCode();
  $('room-code-display').textContent = state.roomCode;
  $('share-link-input').value = buildShareURL(state.roomCode);

  // Load file into state
  await loadFileIntoState(file);

  // Initialize PeerJS with room code as peer ID
  initPeer(state.roomCode, () => {
    // As host, wait for incoming connections
    state.peer.on('connection', (conn) => {
      state.connections.push(conn);
      setupConnectionHandlers(conn);
    });

    // Render file locally
    renderFile(state.currentFile);
    showScreen('room');
    updateConnectionStatus('connecting', 'Waiting for peers…');
    updatePeersList();
    toast(`Room created! Code: ${state.roomCode}`, 'success', 5000);
  });
}

// ─── GUEST FLOW ───────────────────────────────────────────────────────────────
function joinRoom(code) {
  state.role = 'guest';
  state.roomCode = code.toUpperCase();
  $('room-code-display').textContent = state.roomCode;
  $('share-link-input').value = buildShareURL(state.roomCode);

  // Generate unique peer ID for guest
  const guestId = 'GUEST-' + generateCode() + '-' + Date.now().toString(36);

  // Show join status
  $('join-status').classList.remove('hidden');
  $('join-status-text').textContent = 'Initializing peer…';

  initPeer(guestId, () => {
    $('join-status-text').textContent = 'Connecting to host…';

    const conn = state.peer.connect(state.roomCode, {
      reliable: true,
      serialization: 'json',
    });

    state.connections = [conn];
    setupConnectionHandlers(conn);

    // Timeout if host not found
    const timeout = setTimeout(() => {
      if (!conn.open) {
        toast('Could not connect — is the room code correct?', 'error', 5000);
        $('join-status').classList.add('hidden');
        $('btn-join').disabled = false;
        destroyPeer();
      }
    }, 12000);

    conn.on('open', () => {
      clearTimeout(timeout);
      $('join-status').classList.add('hidden');
      showScreen('room');
      updateConnectionStatus('connecting', 'Waiting for file…');
      updatePeersList();
    });
  });
}

// ─── PeerJS init ──────────────────────────────────────────────────────────────
function initPeer(id, onReady) {
  destroyPeer();

  const peer = new Peer(id, {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
    },
  });

  state.peer = peer;

  peer.on('open', (peerId) => {
    console.log('[CollabShare] Peer open:', peerId);
    onReady();
  });

  peer.on('error', (err) => {
    console.error('[CollabShare] Peer error:', err.type, err);
    let msg = 'Connection failed';
    if (err.type === 'peer-unavailable') msg = 'Room not found. Check the code and try again.';
    else if (err.type === 'network')     msg = 'Network error. Check your internet connection.';
    else if (err.type === 'unavailable-id') msg = 'Room code already in use. Generating a new one…';
    toast(msg, 'error', 6000);
    $('join-status').classList.add('hidden');
    $('btn-join').disabled = false;
  });

  peer.on('disconnected', () => {
    console.warn('[CollabShare] Peer disconnected, attempting reconnect…');
    updateConnectionStatus('connecting', 'Reconnecting…');
    try { peer.reconnect(); } catch(e) {}
  });
}

function destroyPeer() {
  if (state.peer) {
    try { state.peer.destroy(); } catch(e) {}
    state.peer = null;
  }
  state.connections = [];
}

// ─── Load file into state ─────────────────────────────────────────────────────
async function loadFileIntoState(file) {
  const category = getFileCategory(file.type, file.name);
  let data;
  if (category === 'text') {
    data = await readFileAsText(file);
  } else {
    data = await readFileAsArrayBuffer(file);
  }
  state.currentFile = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    category,
    data,
  };
}

// ─── Download ─────────────────────────────────────────────────────────────────
function downloadCurrentFile() {
  if (!state.currentFile) return;
  const { name, type, data, category } = state.currentFile;
  let blob;
  if (category === 'text') {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    blob = new Blob([text], { type: type || 'text/plain' });
  } else {
    blob = new Blob([data], { type });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Download started!', 'success');
}

// ─── Share URL ────────────────────────────────────────────────────────────────
function buildShareURL(code) {
  const url = new URL(window.location.href.split('?')[0]);
  url.searchParams.set('room', code);
  return url.toString();
}

// ─── Handle URL params (auto-join) ────────────────────────────────────────────
function checkURLParams() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room && room.length === 6) {
    // Pre-fill code boxes
    const upper = room.toUpperCase();
    for (let i = 0; i < 6; i++) {
      const box = $(`code-${i}`);
      if (box && upper[i]) {
        box.value = upper[i];
        box.classList.add('filled');
      }
    }
    validateJoinButton();
    // Auto scroll to join card
    setTimeout(() => {
      $('card-join').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('code-0').focus();
    }, 300);
  }
}

// ─── Landing UI setup ─────────────────────────────────────────────────────────
let pendingFile = null;

function setupLanding() {
  const dropZone   = $('drop-zone');
  const fileInput  = $('file-input');
  const btnCreate  = $('btn-create');
  const fileSelected  = $('file-selected');
  const fileNameDisp  = $('file-name-display');
  const fileSizeDisp  = $('file-size-display');
  const fileThumb     = $('file-thumb');
  const btnClearFile  = $('btn-clear-file');

  // Drop zone click
  dropZone.addEventListener('click', () => fileInput.click());

  // Drag events
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  });

  // File input change
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) setSelectedFile(file);
  });

  function setSelectedFile(file) {
    pendingFile = file;
    fileNameDisp.textContent = file.name;
    fileSizeDisp.textContent = formatBytes(file.size);
    fileThumb.textContent = getExtLabel(file.name);
    fileSelected.classList.remove('hidden');
    dropZone.classList.add('hidden');
    btnCreate.disabled = false;
  }

  btnClearFile.addEventListener('click', () => {
    pendingFile = null;
    fileInput.value = '';
    fileSelected.classList.add('hidden');
    dropZone.classList.remove('hidden');
    btnCreate.disabled = true;
  });

  // Create room
  btnCreate.addEventListener('click', async () => {
    if (!pendingFile) return;
    btnCreate.disabled = true;
    btnCreate.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Creating…`;
    try {
      await createRoom(pendingFile);
    } catch(e) {
      toast('Error creating room: ' + e.message, 'error');
      btnCreate.disabled = false;
      btnCreate.innerHTML = `Create Room & Share`;
    }
  });

  // Code box inputs
  const codeBoxes = document.querySelectorAll('.code-box');

  codeBoxes.forEach((box, idx) => {
    box.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
      box.value = val ? val[val.length - 1] : '';
      box.classList.toggle('filled', !!box.value);
      if (box.value && idx < 5) {
        document.querySelectorAll('.code-box')[idx + 1].focus();
      }
      validateJoinButton();
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && idx > 0) {
        const prev = document.querySelectorAll('.code-box')[idx - 1];
        prev.value = '';
        prev.classList.remove('filled');
        prev.focus();
        validateJoinButton();
      }
      if (e.key === 'Enter') {
        const code = getEnteredCode();
        if (code.length === 6) triggerJoin(code);
      }
    });

    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text')
        .replace(/[^a-zA-Z0-9]/g,'').toUpperCase().substring(0,6);
      const allBoxes = document.querySelectorAll('.code-box');
      for (let i = 0; i < 6; i++) {
        allBoxes[i].value = text[i] || '';
        allBoxes[i].classList.toggle('filled', !!allBoxes[i].value);
      }
      validateJoinButton();
      if (text.length === 6) allBoxes[5].focus();
    });
  });

  $('btn-join').addEventListener('click', () => {
    const code = getEnteredCode();
    if (code.length === 6) triggerJoin(code);
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

// ─── Room UI setup ────────────────────────────────────────────────────────────
function setupRoom() {
  // Copy room code
  $('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(state.roomCode).then(() => toast('Code copied!', 'success'));
  });

  // Copy share link
  $('btn-copy-link').addEventListener('click', () => {
    navigator.clipboard.writeText($('share-link-input').value).then(() => toast('Link copied!', 'success'));
  });

  // Download
  $('btn-download').addEventListener('click', downloadCurrentFile);
  $('btn-download-binary').addEventListener('click', downloadCurrentFile);

  // Change file (host only)
  const fileInputRoom = $('file-input-room');
  $('btn-change-file').addEventListener('click', () => fileInputRoom.click());
  fileInputRoom.addEventListener('change', async () => {
    const file = fileInputRoom.files[0];
    if (!file) return;
    showSyncIndicator();
    await loadFileIntoState(file);
    renderFile(state.currentFile);
    // Broadcast new file to all peers
    state.connections.filter(c => c.open).forEach(c => sendFileTo(c));
    hideSyncIndicator();
    showSaveIndicator();
    toast(`File updated: ${file.name}`, 'success');
    fileInputRoom.value = '';
  });

  // Leave room
  $('btn-leave').addEventListener('click', () => {
    showModal({
      icon: '👋',
      title: 'Leave Room?',
      body: 'You will be disconnected from this room. Peers will be notified.',
      confirmText: 'Leave',
      cancelText: 'Stay',
      onConfirm: () => {
        broadcast({ type: 'peer-left', payload: {} });
        destroyPeer();
        state.currentFile = null;
        state.roomCode = null;
        state.role = null;
        $('viewer-empty').classList.remove('hidden');
        ['text-viewer','image-viewer','pdf-viewer','binary-viewer'].forEach(id => $(id).classList.add('hidden'));
        showScreen('landing');
        toast('You left the room', 'info');
      },
    });
  });

  // Mode tabs
  $('tab-view').addEventListener('click', () => applyViewMode('view'));
  $('tab-edit').addEventListener('click', () => {
    if (!state.isTextFile) return;
    applyViewMode('edit');
  });

  // Text editor real-time sync
  $('text-editor').addEventListener('input', () => {
    if (state.mode !== 'edit') return;
    const text = $('text-editor').value;
    if (state.currentFile) state.currentFile.data = text;

    clearTimeout(state.editDebounce);
    state.editDebounce = setTimeout(() => {
      broadcast({ type: 'text-update', payload: { text } });
      showSaveIndicator();
    }, 80); // 80ms debounce for near-real-time feel
  });
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal({ icon, title, body, confirmText = 'Confirm', cancelText = 'Cancel', onConfirm }) {
  $('modal-icon').textContent = icon || '';
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal-confirm').textContent = confirmText;
  $('modal-cancel').textContent = cancelText;

  $('modal-backdrop').classList.remove('hidden');

  const cleanup = () => $('modal-backdrop').classList.add('hidden');

  $('modal-confirm').onclick = () => { cleanup(); onConfirm?.(); };
  $('modal-cancel').onclick  = cleanup;
  $('modal-backdrop').onclick = (e) => { if (e.target === $('modal-backdrop')) cleanup(); };
}

// ─── Host-only guard for file editing ─────────────────────────────────────────
function setupHostGuards() {
  // Continuously check: only host can change files
  const updateHostUI = () => {
    const isHost = state.role === 'host';
    $('btn-change-file').style.display = isHost ? '' : 'none';
  };
  // Re-run whenever we enter the room
  const origShowRoom = showScreen;
  // Observe screen changes
  const observer = new MutationObserver(() => {
    if (screens.room.classList.contains('active')) updateHostUI();
  });
  observer.observe(screens.room, { attributes: true, attributeFilter: ['class'] });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  setupLanding();
  setupRoom();
  setupHostGuards();
  checkURLParams();

  // Global paste shortcut: Ctrl+V on landing pastes room code
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && screens.landing.classList.contains('active')) {
      $('code-0').focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
