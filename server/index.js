import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROOM_SECRET = process.env.ROOM_SECRET || '';
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM) || 8;

/** @type {Map<string, Map<string, import('ws').WebSocket>>} */
const rooms = new Map();

function roomIdOk(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function verifyRoomToken(roomId, token) {
  if (!ROOM_SECRET) return true;
  if (!token) return false;
  const expected = crypto
    .createHmac('sha256', ROOM_SECRET)
    .update(roomId)
    .digest('hex')
    .slice(0, 32);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getIceServers() {
  const servers = [];
  const stun = process.env.STUN_URLS;
  if (stun) {
    for (const url of stun.split(',').map((s) => s.trim()).filter(Boolean)) {
      servers.push({ urls: url });
    }
  } else {
    servers.push({ urls: 'stun:stun.l.google.com:19302' });
  }
  const turnUrls = process.env.TURN_URLS;
  const turnUser = process.env.TURN_USERNAME;
  const turnCred = process.env.TURN_CREDENTIAL;
  if (turnUrls && turnUser && turnCred) {
    for (const url of turnUrls.split(',').map((s) => s.trim()).filter(Boolean)) {
      servers.push({ urls: url, username: turnUser, credential: turnCred });
    }
  }
  return servers;
}

function broadcast(roomId, exceptPeerId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const [pid, socket] of room) {
    if (pid !== exceptPeerId && socket.readyState === socket.OPEN) {
      socket.send(data);
    }
  }
}

function sendTo(roomId, peerId, message) {
  const room = rooms.get(roomId);
  const socket = room?.get(peerId);
  if (socket?.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function leaveRoom(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(peerId);
  if (room.size === 0) rooms.delete(roomId);
  else broadcast(roomId, peerId, { type: 'peer-left', peerId });
}

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/ice', (_req, res) => {
  res.json({ iceServers: getIceServers() });
});

app.get('/api/room-token', (req, res) => {
  const roomId = String(req.query.roomId || '');
  if (!ROOM_SECRET) {
    return res.status(501).json({ error: 'ROOM_SECRET not configured' });
  }
  if (!roomIdOk(roomId)) {
    return res.status(400).json({ error: 'invalid roomId' });
  }
  const token = crypto
    .createHmac('sha256', ROOM_SECRET)
    .update(roomId)
    .digest('hex')
    .slice(0, 32);
  res.json({ roomId, token });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  /** @type {{ roomId?: string, peerId?: string, displayName?: string }} */
  const ctx = {};

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const { roomId, peerId, displayName, token } = msg;
      if (!roomIdOk(roomId) || typeof peerId !== 'string' || peerId.length > 64) {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid join' }));
        return;
      }
      if (!verifyRoomToken(roomId, token)) {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid room token' }));
        return;
      }

      let room = rooms.get(roomId);
      if (!room) {
        room = new Map();
        rooms.set(roomId, room);
      }
      if (room.size >= MAX_PEERS_PER_ROOM && !room.has(peerId)) {
        socket.send(JSON.stringify({ type: 'error', message: 'room full' }));
        return;
      }

      ctx.roomId = roomId;
      ctx.peerId = peerId;
      ctx.displayName = displayName || peerId;

      const existing = room.get(peerId);
      if (existing && existing !== socket) {
        existing.close();
      }
      room.set(peerId, socket);

      const peers = [...room.keys()].filter((id) => id !== peerId);
      socket.send(
        JSON.stringify({
          type: 'joined',
          roomId,
          peerId,
          peers: peers.map((id) => ({ peerId: id })),
          iceServers: getIceServers(),
        }),
      );
      broadcast(roomId, peerId, {
        type: 'peer-joined',
        peerId,
        displayName: ctx.displayName,
      });
      return;
    }

    if (msg.type === 'signal' && ctx.roomId && ctx.peerId) {
      const { to, payload } = msg;
      if (typeof to !== 'string' || !payload) return;
      sendTo(ctx.roomId, to, {
        type: 'signal',
        from: ctx.peerId,
        payload,
      });
      return;
    }

    if (msg.type === 'leave' && ctx.roomId && ctx.peerId) {
      leaveRoom(ctx.roomId, ctx.peerId);
      ctx.roomId = undefined;
      ctx.peerId = undefined;
    }
  });

  socket.on('close', () => {
    if (ctx.roomId && ctx.peerId) {
      leaveRoom(ctx.roomId, ctx.peerId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`LanMeeting signaling on http://localhost:${PORT}`);
  console.log(`WebSocket path: /ws`);
});