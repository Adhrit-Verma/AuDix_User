import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

import { openDbFile, initSchema } from './db.js';
import { createAccessRequest, setupPinWithCode, loginFlat, normalizeFlatId, getSetupStatus } from './user_db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5005);
const SESSION_SECRET = process.env.SESSION_SECRET || '';

const LIVE_TOKEN = process.env.AUDIX_LIVE_TOKEN || '';
if (!LIVE_TOKEN) {
  console.error('Missing AUDIX_LIVE_TOKEN in .env');
  process.exit(1);
}

if (!SESSION_SECRET) {
  console.error('Missing SESSION_SECRET in .env');
  process.exit(1);
}

const DB_PATH = process.env.AUDIX_DB_PATH;
const db = openDbFile(DB_PATH);
initSchema(db);

const app = express();

app.use(session({
  name: 'audix_user_sid',      // ✅ NEW
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax'
  }
}));



app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CSP (keep simple for static + fetch)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:;"
  );
  next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

function requireUser(req, res, next) {
  if (req.session?.user?.flat_id) return next();
  return res.redirect('/login');
}

// ---- live state (in-memory, fast) ----
const live = {
  startedAt: Date.now(),
  clients: new Map(),   // ws -> { flat_id, ip, role, listeningTo, connectedAt }
  stations: new Map()   // broadcasterFlatId -> { ip, startedAt, listeners:Set<ws>, audio: { micOn:false, sysOn:false, ptt:false, speaking:false, micLevel:0 } }
};

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || '';
}

function requireLiveToken(req, res, next) {
  const tok = req.headers['x-audix-live-token'];
  if (tok && tok === LIVE_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
}

function buildPublicStations() {
  // For users: no IPs, no listener personal details
  const out = [];
  for (const [flat_id, st] of live.stations.entries()) {
    out.push({
      id: flat_id,
      name: flat_id,
      live: true,
      listeners: st.listeners.size,
      startedAt: st.startedAt
    });
  }
  // stable order
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

function buildInternalSnapshot() {
  // Internal: includes IPs + mapping
  const stations = [];
  for (const [broadcaster, st] of live.stations.entries()) {
    const listeners = [];
    for (const ws of st.listeners) {
      const c = live.clients.get(ws);
      if (!c) continue;
      listeners.push({
        flat_id: c.flat_id,
        ip: c.ip,
        connectedAt: c.connectedAt
      });
    }

    stations.push({
      broadcaster: {
        flat_id: broadcaster,
        ip: st.ip,
        startedAt: st.startedAt,
        audio: st.audio || { micOn: false, sysOn: false, ptt: false, speaking: false, micLevel: 0 }
      },
      listeners
    });
  }

  // clients list
  const clients = [];
  for (const c of live.clients.values()) {
    clients.push({
      flat_id: c.flat_id,
      ip: c.ip,
      role: c.role,
      listeningTo: c.listeningTo,
      connectedAt: c.connectedAt
    });
  }

  return {
    ok: true,
    ts: Date.now(),
    uptimeSec: Math.floor((Date.now() - live.startedAt) / 1000),
    totals: {
      wsClients: live.clients.size,
      stations: live.stations.size
    },
    stations,
    clients
  };
}


// Pages
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/app', requireUser, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// APIs
app.post('/api/request-access', (req, res) => {
  const { flat_id, name } = req.body || {};
  const out = createAccessRequest(db, { flat_id, name });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post('/api/setup-pin', async (req, res) => {
  const { flat_id, code, pin4, password } = req.body || {};
  const out = await setupPinWithCode(db, { flat_id, code, pin4, password });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.get('/api/setup-status', (req, res) => {
  const flat_id = req.query.flat_id;
  const out = getSetupStatus(db, { flat_id });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});


app.post('/api/login', async (req, res) => {
  const { flat_id, pin4, password, remember } = req.body || {};
  const out = await loginFlat(db, { flat_id, pin4, password });

  if (!out.ok) return res.status(401).json(out);

  req.session.user = { flat_id: normalizeFlatId(flat_id) };

  // remember me
  if (remember === '1' || remember === 'on') {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  } else {
    req.session.cookie.expires = false;
  }

  req.session.save(() => res.json({ ok: true, flat_id: req.session.user.flat_id }));
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Internal live snapshot (for admin later; includes IP + listener mapping)
app.get('/api/internal/live-snapshot', requireLiveToken, (req, res) => {
  res.json(buildInternalSnapshot());
});

// Public live list (for users)
app.get('/api/live', requireUser, (req, res) => {
  res.json({
    ok: true,
    flat_id: req.session.user.flat_id,
    stations: buildPublicStations()
  });
});


// Report (placeholder; we’ll implement 75% rule + bans next)
app.post('/api/report', requireUser, (req, res) => {
  const { stationId } = req.body || {};
  if (!stationId) return res.status(400).json({ ok: false, error: 'stationId required' });
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`AuDiX User server running: http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});

const wssPresence = new WebSocketServer({ noServer: true });
const wssSignal = new WebSocketServer({ noServer: true });



// Route upgrades
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/ws/presence') {
    wssPresence.handleUpgrade(req, socket, head, (ws) => {
      wssPresence.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/ws/signal') {
    wssSignal.handleUpgrade(req, socket, head, (ws) => {
      wssSignal.emit('connection', ws, req);
    });
    return;
  }

  socket.destroy();
});


wssPresence.on('connection', (ws, req) => {
  const ip = getIP(req);

  const client = {
    flat_id: null,
    ip,
    role: 'idle',        // idle | broadcaster | listener
    listeningTo: null,
    connectedAt: Date.now()
  };

  live.clients.set(ws, client);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'identify') {
      client.flat_id = normalizeFlatId(msg.flat_id);
      return;
    }

    if (msg.type === 'broadcast:start') {
      if (!client.flat_id) return;

      // if they were listening, stop listening first
      if (client.listeningTo) {
        live.stations.get(client.listeningTo)?.listeners.delete(ws);
        client.listeningTo = null;
      }

      client.role = 'broadcaster';
      live.stations.set(client.flat_id, {
        ip: client.ip,
        startedAt: Date.now(),
        listeners: new Set(),
        audio: {
          micOn: false,
          sysOn: false,
          ptt: false,
          speaking: false,
          micLevel: 0
        }
      });
      return;
    }

    if (msg.type === 'broadcast:stop') {
      if (!client.flat_id) return;

      const st = live.stations.get(client.flat_id);
      if (st) {
        for (const sock of st.listeners) {
          const lc = live.clients.get(sock);
          if (lc) {
            lc.role = 'idle';
            lc.listeningTo = null;
          }
        }
      }

      live.stations.delete(client.flat_id);
      client.role = 'idle';
      return;
    }

    if (msg.type === 'broadcast:status') {
      if (!client.flat_id) return;
      const st = live.stations.get(client.flat_id);
      if (!st) return;

      st.audio = st.audio || {};
      st.audio.micOn = !!msg.micOn;
      st.audio.sysOn = !!msg.sysOn;
      st.audio.ptt = !!msg.ptt;
      st.audio.speaking = !!msg.speaking;
      st.audio.micLevel = Number(msg.micLevel || 0);

      return;
    }

    if (msg.type === 'listen:start') {
      const target = normalizeFlatId(msg.targetFlat);
      const st = live.stations.get(target);
      if (!st) return;

      // can’t listen while broadcasting
      if (client.role === 'broadcaster') return;

      // switch station if already listening
      if (client.listeningTo && client.listeningTo !== target) {
        live.stations.get(client.listeningTo)?.listeners.delete(ws);
      }

      client.role = 'listener';
      client.listeningTo = target;
      st.listeners.add(ws);
      return;
    }

    if (msg.type === 'listen:stop') {
      if (client.listeningTo) {
        live.stations.get(client.listeningTo)?.listeners.delete(ws);
      }
      client.role = 'idle';
      client.listeningTo = null;
      return;
    }
  });

  ws.on('close', () => {
    const c = live.clients.get(ws);
    if (!c) return;

    // if listener, remove from station
    if (c.listeningTo) {
      live.stations.get(c.listeningTo)?.listeners.delete(ws);
    }

    // if broadcaster, end station (and reset listeners)
    if (c.role === 'broadcaster' && c.flat_id) {
      const st = live.stations.get(c.flat_id);
      if (st) {
        for (const sock of st.listeners) {
          const lc = live.clients.get(sock);
          if (lc) {
            lc.role = 'idle';
            lc.listeningTo = null;
          }
        }
      }
      live.stations.delete(c.flat_id);
    }

    live.clients.delete(ws);
  });

});
// ---- WebRTC signaling state ----
const signalClients = new Map(); // ws -> { id, flat_id, ip, role, listeningTo }
const stationBroadcasterWS = new Map(); // flat_id -> ws

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

wssSignal.on('connection', (ws, req) => {
  const ip = getIP(req);

  const sc = {
    id: makeId(),
    flat_id: null,
    ip,
    role: 'unknown',       // broadcaster | listener
    listeningTo: null
  };
  signalClients.set(ws, sc);

  // tell client its id
  safeSend(ws, { type: 'hello', id: sc.id });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // identify is mandatory
    if (msg.type === 'identify') {
      sc.flat_id = normalizeFlatId(msg.flat_id);
      sc.role = msg.role === 'broadcaster' ? 'broadcaster' : 'listener';

      if (sc.role === 'broadcaster') {
        // register broadcaster ws for its flat
        stationBroadcasterWS.set(sc.flat_id, ws);
      }
      return;
    }

    // listener wants to listen to a station
    if (msg.type === 'listen:join') {
      const targetFlat = normalizeFlatId(msg.targetFlat);
      sc.role = 'listener';
      sc.listeningTo = targetFlat;

      // station must exist (presence)
      const st = live.stations.get(targetFlat);
      if (!st) {
        safeSend(ws, { type: 'listen:error', error: 'STATION_OFFLINE' });
        return;
      }

      const bws = stationBroadcasterWS.get(targetFlat);
      if (!bws) {
        safeSend(ws, { type: 'listen:error', error: 'BROADCASTER_SIGNAL_NOT_READY' });
        return;
      }

      // Ask broadcaster to create offer for this listener id
      safeSend(bws, { type: 'listener:join', listenerId: sc.id });

      safeSend(ws, { type: 'listen:ok', targetFlat });
      return;
    }

    // listener leaves
    if (msg.type === 'listen:leave') {
      if (!sc.listeningTo) return;
      const target = sc.listeningTo;
      sc.listeningTo = null;

      const bws = stationBroadcasterWS.get(target);
      if (bws) safeSend(bws, { type: 'listener:leave', listenerId: sc.id });

      return;
    }

    // Offer from broadcaster -> listener
    if (msg.type === 'webrtc:offer') {
      // msg: { listenerId, sdp }
      const listenerWs = [...signalClients.entries()].find(([w, c]) => c.id === msg.listenerId)?.[0];
      if (!listenerWs) return;
      safeSend(listenerWs, { type: 'webrtc:offer', from: sc.id, sdp: msg.sdp });
      return;
    }

    // Answer from listener -> broadcaster
    if (msg.type === 'webrtc:answer') {
      // msg: { broadcasterFlat, sdp }
      const bws = stationBroadcasterWS.get(normalizeFlatId(msg.broadcasterFlat));
      if (!bws) return;
      safeSend(bws, { type: 'webrtc:answer', listenerId: sc.id, sdp: msg.sdp });
      return;
    }

    // ICE candidate relay
    if (msg.type === 'webrtc:ice') {
      // broadcaster sends: { listenerId, candidate }
      if (sc.role === 'broadcaster' && msg.listenerId) {
        const listenerWs = [...signalClients.entries()].find(([w, c]) => c.id === msg.listenerId)?.[0];
        if (!listenerWs) return;
        safeSend(listenerWs, { type: 'webrtc:ice', from: sc.id, candidate: msg.candidate });
        return;
      }

      // listener sends: { broadcasterFlat, candidate }
      if (sc.role === 'listener' && msg.broadcasterFlat) {
        const bws = stationBroadcasterWS.get(normalizeFlatId(msg.broadcasterFlat));
        if (!bws) return;
        safeSend(bws, { type: 'webrtc:ice', listenerId: sc.id, candidate: msg.candidate });
        return;
      }
    }
  });

  ws.on('close', () => {
    const c = signalClients.get(ws);
    if (!c) return;

    if (c.role === 'broadcaster' && c.flat_id) {
      if (stationBroadcasterWS.get(c.flat_id) === ws) {
        stationBroadcasterWS.delete(c.flat_id);
      }
    }

    signalClients.delete(ws);
  });
});