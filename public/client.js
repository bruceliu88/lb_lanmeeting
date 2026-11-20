const CHUNK_SIZE = 16 * 1024;

const $ = (id) => document.getElementById(id);

const joinPanel = $('join-panel');
const meetingPanel = $('meeting-panel');
const statusEl = $('status');
const videoGrid = $('video-grid');
const chatLog = $('chat-log');
const fileLog = $('file-log');
const fileProgress = $('file-progress');

let ws;
let peerId;
let roomId;
let displayName;
let localStream;
/** @type {Map<string, RTCPeerConnection>} */
const peers = new Map();
/** @type {Map<string, RTCDataChannel>} */
const dataChannels = new Map();
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

function setStatus(text) {
  statusEl.textContent = text;
}

function randomId() {
  return crypto.randomUUID();
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function logChat(text, from = 'me') {
  const li = document.createElement('li');
  li.textContent = from === 'me' ? `我: ${text}` : `${from}: ${text}`;
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function logFile(text) {
  const li = document.createElement('li');
  li.textContent = text;
  fileLog.appendChild(li);
}

function sendSignal(to, payload) {
  ws?.send(JSON.stringify({ type: 'signal', to, payload }));
}

function ensureVideoTile(remotePeerId, stream, label) {
  let tile = document.getElementById(`tile-${remotePeerId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `tile-${remotePeerId}`;
    tile.className = 'video-tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.id = `video-${remotePeerId}`;
    const cap = document.createElement('span');
    cap.className = 'label';
    cap.textContent = label;
    tile.appendChild(video);
    tile.appendChild(cap);
    videoGrid.appendChild(tile);
  }
  const video = tile.querySelector('video');
  video.srcObject = stream;
}

function ensureLocalPreview() {
  let tile = document.getElementById('tile-local');
  if (!tile && localStream) {
    tile = document.createElement('div');
    tile.id = 'tile-local';
    tile.className = 'video-tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = localStream;
    const cap = document.createElement('span');
    cap.className = 'label';
    cap.textContent = `${displayName}（本机）`;
    tile.appendChild(video);
    tile.appendChild(cap);
    videoGrid.prepend(tile);
  }
}

function handleDataMessage(fromPeerId, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    logChat(data, fromPeerId);
    return;
  }

  switch (msg.type) {
    case 'chat':
      logChat(msg.text, msg.from || fromPeerId);
      break;
    case 'file-meta':
      logFile(`收到文件: ${msg.name} (${msg.size} bytes) from ${msg.from || fromPeerId}`);
      window.__incomingFiles = window.__incomingFiles || new Map();
      window.__incomingFiles.set(msg.id, {
        name: msg.name,
        size: msg.size,
        chunks: [],
        from: fromPeerId,
      });
      break;
    case 'file-chunk': {
      const rec = window.__incomingFiles?.get(msg.id);
      if (rec) rec.chunks[msg.seq] = msg.data;
      break;
    }
    case 'file-end': {
      const rec = window.__incomingFiles?.get(msg.id);
      if (!rec) break;
      const parts = rec.chunks.filter(Boolean);
      const blob = new Blob(
        parts.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
      );
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = rec.name;
      a.textContent = `下载 ${rec.name}`;
      const li = document.createElement('li');
      li.appendChild(a);
      fileLog.appendChild(li);
      window.__incomingFiles.delete(msg.id);
      logFile(`文件完成: ${rec.name}`);
      break;
    }
    default:
      break;
  }
}

function attachDataChannel(remotePeerId, channel) {
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    dataChannels.set(remotePeerId, channel);
    logFile(`DataChannel 已连接: ${remotePeerId}`);
  };
  channel.onclose = () => dataChannels.delete(remotePeerId);
  channel.onmessage = (ev) => handleDataMessage(remotePeerId, ev.data);
}

async function createPeerConnection(remotePeerId, isInitiator) {
  if (peers.has(remotePeerId)) return peers.get(remotePeerId);

  const pc = new RTCPeerConnection({ iceServers });
  peers.set(remotePeerId, pc);

  localStream?.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendSignal(remotePeerId, { candidate: ev.candidate });
    }
  };

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    ensureVideoTile(remotePeerId, stream, remotePeerId);
  };

  pc.ondatachannel = (ev) => attachDataChannel(remotePeerId, ev.channel);

  if (isInitiator) {
    const dc = pc.createDataChannel('lanmeeting', { ordered: true });
    attachDataChannel(remotePeerId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(remotePeerId, { sdp: pc.localDescription });
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      pc.close();
      peers.delete(remotePeerId);
      dataChannels.delete(remotePeerId);
      document.getElementById(`tile-${remotePeerId}`)?.remove();
    }
  };

  return pc;
}

async function handleSignal(from, payload) {
  let pc = peers.get(from);
  if (!pc) {
    pc = await createPeerConnection(from, false);
  }

  if (payload.sdp) {
    await pc.setRemoteDescription(payload.sdp);
    if (payload.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { sdp: pc.localDescription });
    }
  } else if (payload.candidate) {
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch (e) {
      console.warn('ICE candidate error', e);
    }
  }
}

function broadcastChat(text) {
  const payload = JSON.stringify({
    type: 'chat',
    text,
    from: displayName,
    ts: Date.now(),
  });
  for (const dc of dataChannels.values()) {
    if (dc.readyState === 'open') dc.send(payload);
  }
}

async function sendFile(file) {
  const targets = [...dataChannels.entries()].filter(([, dc]) => dc.readyState === 'open');
  if (!targets.length) {
    logFile('尚无已连接的 DataChannel，无法发送文件');
    return;
  }
  const id = randomId();
  const meta = JSON.stringify({
    type: 'file-meta',
    id,
    name: file.name,
    size: file.size,
    from: displayName,
  });
  const end = JSON.stringify({ type: 'file-end', id });

  for (const [, dc] of targets) {
    dc.send(meta);
  }

  let offset = 0;
  let seq = 0;
  fileProgress.value = 0;
  fileProgress.max = file.size;

  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const chunkMsg = JSON.stringify({ type: 'file-chunk', id, seq, data: b64 });
    for (const [, dc] of targets) {
      if (dc.readyState === 'open') dc.send(chunkMsg);
    }
    offset += slice.size;
    seq += 1;
    fileProgress.value = offset;
    await new Promise((r) => setTimeout(r, 0));
  }

  for (const [, dc] of targets) {
    dc.send(end);
  }
  logFile(`已发送: ${file.name}`);
  fileProgress.value = file.size;
}

async function joinMeeting() {
  displayName = $('display-name').value.trim() || 'Guest';
  roomId = $('room-id').value.trim() || 'default';
  const token = $('room-token').value.trim();
  peerId = randomId();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
  } catch (e) {
    setStatus(`无法打开摄像头/麦克风: ${e.message}`);
    return;
  }

  const iceRes = await fetch('/api/ice');
  const iceJson = await iceRes.json();
  if (iceJson.iceServers?.length) iceServers = iceJson.iceServers;

  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'join',
        roomId,
        peerId,
        displayName,
        token: token || undefined,
      }),
    );
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'error') {
      setStatus(msg.message);
      return;
    }
    if (msg.type === 'joined') {
      joinPanel.classList.add('hidden');
      meetingPanel.classList.remove('hidden');
      $('room-label').textContent = `房间: ${roomId} · 本端 ${peerId.slice(0, 8)}…`;
      ensureLocalPreview();
      if (msg.iceServers?.length) iceServers = msg.iceServers;
      for (const p of msg.peers) {
        await createPeerConnection(p.peerId, true);
      }
      setStatus('');
      return;
    }
    if (msg.type === 'peer-joined') {
      await createPeerConnection(msg.peerId, true);
      return;
    }
    if (msg.type === 'peer-left') {
      peers.get(msg.peerId)?.close();
      peers.delete(msg.peerId);
      dataChannels.delete(msg.peerId);
      document.getElementById(`tile-${msg.peerId}`)?.remove();
      return;
    }
    if (msg.type === 'signal') {
      await handleSignal(msg.from, msg.payload);
    }
  };

  ws.onclose = () => setStatus('信令连接已断开');
}

function leaveMeeting() {
  ws?.send(JSON.stringify({ type: 'leave' }));
  ws?.close();
  for (const pc of peers.values()) pc.close();
  peers.clear();
  dataChannels.clear();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = undefined;
  videoGrid.innerHTML = '';
  meetingPanel.classList.add('hidden');
  joinPanel.classList.remove('hidden');
}

$('btn-join').addEventListener('click', () => joinMeeting());
$('btn-leave').addEventListener('click', () => leaveMeeting());
$('btn-send-chat').addEventListener('click', () => {
  const text = $('chat-text').value.trim();
  if (!text) return;
  logChat(text, 'me');
  broadcastChat(text);
  $('chat-text').value = '';
});
$('chat-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-send-chat').click();
});
$('file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) sendFile(file);
  e.target.value = '';
});

fetch('/api/room-token?roomId=test')
  .then((r) => {
    if (r.status !== 501) $('token-row').classList.remove('hidden');
  })
  .catch(() => {});