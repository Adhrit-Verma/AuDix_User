import { WebSocketServer } from "ws";
import crypto from "crypto";
import "dotenv/config";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import path from "path";
import { fileURLToPath } from "url";

// ✅ Postgres DB helpers
import { pool, query, migrate } from "./db_pg.js";

// ✅ Postgres user DB functions
import {
  createAccessRequest,
  setupPinWithCode,
  loginFlat,
  normalizeFlatId,
  getSetupStatus
} from "./user_db_pg.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5005);
const SESSION_SECRET = process.env.SESSION_SECRET || "";

const LIVE_TOKEN = process.env.AUDIX_LIVE_TOKEN || "";
if (!LIVE_TOKEN) {
  console.error("Missing AUDIX_LIVE_TOKEN in env");
  process.exit(1);
}

if (!SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in env");
  process.exit(1);
}

// ✅ Run migrations once on boot (creates tables if missing)
await migrate();
console.log("[DB] Postgres connected & migrated");

const app = express();
app.set("trust proxy", 1);

// ✅ Persist sessions in Postgres (fixes MemoryStore warning)
const PgSession = pgSession(session);

app.use(
  session({
    name: "audix_user_sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false, // ✅ IMPORTANT: stop auto-creating (prevents session_pkey collision)
    }),


    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production", // Render
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days default
    }
  })
);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CSP (keep simple for static + fetch)
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:;"
  );
  next();
});

app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use("/public", express.static(path.join(__dirname, "public"), { maxAge: 0 }));

function requireUser(req, res, next) {
  if (req.session?.user?.flat_id) return next();
  return res.redirect("/login");
}

// ---- live state (in-memory, fast) ----
const live = {
  startedAt: Date.now(),
  clients: new Map(), // ws -> { flat_id, ip, role, listeningTo, connectedAt }
  stations: new Map() // broadcasterFlatId -> { ip, startedAt, listeners:Set<ws>, audio: {...} }
};

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    ""
  );
}

function requireLiveToken(req, res, next) {
  const tok = req.headers["x-audix-live-token"];
  if (tok && tok === LIVE_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
}

function buildPublicStations() {
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
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

function buildInternalSnapshot() {
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
        audio: st.audio || {
          micOn: false,
          sysOn: false,
          ptt: false,
          speaking: false,
          micLevel: 0
        }
      },
      listeners
    });
  }

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
app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/setup", (req, res) => res.sendFile(path.join(__dirname, "public", "setup.html")));
app.get("/app", requireUser, (req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));

// APIs

// ✅ async + await because Postgres calls are async
app.post("/api/request-access", async (req, res) => {
  const { flat_id, name } = req.body || {};
  const out = await createAccessRequest(query, { flat_id, name });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/setup-pin", async (req, res) => {
  const { flat_id, code, pin4, password } = req.body || {};
  const out = await setupPinWithCode(query, { flat_id, code, pin4, password });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// ✅ async + await
app.get("/api/setup-status", async (req, res) => {
  const flat_id = req.query.flat_id;
  const out = await getSetupStatus(query, { flat_id });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.post("/api/login", async (req, res) => {
  const { flat_id, pin4, password, remember } = req.body || {};
  const out = await loginFlat(query, { flat_id, pin4, password });

  if (!out.ok) return res.status(401).json(out);

  req.session.user = { flat_id: normalizeFlatId(flat_id) };

  // remember me
  if (remember === "1" || remember === "on") {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  } else {
    req.session.cookie.expires = false;
  }

  req.session.save(() => res.json({ ok: true, flat_id: req.session.user.flat_id }));
});

app.post("/api/logout", (req, res) => {
  // Always respond OK + clear cookie (helps mobile + latency)
  req.session.destroy(() => {
    res.clearCookie("audix_user_sid", { path: "/" });
    res.json({ ok: true });
  });
});


// Internal live snapshot (for admin later; includes IP + listener mapping)
app.get("/api/internal/live-snapshot", requireLiveToken, (req, res) => {
  res.json(buildInternalSnapshot());
});

// Public live list (for users)
app.get("/api/live", requireUser, (req, res) => {
  res.json({
    ok: true,
    flat_id: req.session.user.flat_id,
    stations: buildPublicStations()
  });
});

// Report (placeholder)
app.post("/api/report", requireUser, (req, res) => {
  const { stationId } = req.body || {};
  if (!stationId) return res.status(400).json({ ok: false, error: "stationId required" });
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`AuDiX User server running: http://localhost:${PORT}`);
});

const wssPresence = new WebSocketServer({ noServer: true });
const wssSignal = new WebSocketServer({ noServer: true });

// Route upgrades
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/ws/presence") {
    wssPresence.handleUpgrade(req, socket, head, (ws) => {
      wssPresence.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === "/ws/signal") {
    wssSignal.handleUpgrade(req, socket, head, (ws) => {
      wssSignal.emit("connection", ws, req);
    });
    return;
  }

  socket.destroy();
});

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

wssPresence.on("connection", (ws, req) => {
  const ip = getIP(req);

  const client = {
    flat_id: null,
    ip,
    role: "idle", // idle | broadcaster | listener
    listeningTo: null,
    connectedAt: Date.now()
  };

  live.clients.set(ws, client);

  // ✅ Heartbeat: kill "ghost" sockets (mobile tab close, flaky network)
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const hb = setInterval(() => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { }
      clearInterval(hb);
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { }
  }, 15000);


  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "identify") {
      client.flat_id = normalizeFlatId(msg.flat_id);
      return;
    }

    if (msg.type === "broadcast:start") {
      if (!client.flat_id) return;

      // 🔒 Deny if already broadcasting from another device for same flat
      const existing = live.stations.get(client.flat_id);
      if (existing) {
        safeSend(ws, { type: "broadcast:denied", reason: "ALREADY_BROADCASTING" });
        return;
      }

      // if was listening, stop it
      if (client.listeningTo) {
        live.stations.get(client.listeningTo)?.listeners.delete(ws);
        client.listeningTo = null;
      }

      client.role = "broadcaster";
      live.stations.set(client.flat_id, {
        ip: client.ip,
        startedAt: Date.now(),
        listeners: new Set(),
        audio: { micOn: false, sysOn: false, ptt: false, speaking: false, micLevel: 0 }
      });

      return;
    }


    if (msg.type === "broadcast:stop") {
      if (!client.flat_id) return;

      const st = live.stations.get(client.flat_id);
      if (st) {
        for (const sock of st.listeners) {
          const lc = live.clients.get(sock);
          if (lc) {
            lc.role = "idle";
            lc.listeningTo = null;
          }
        }
      }

      live.stations.delete(client.flat_id);
      client.role = "idle";
      return;
    }

    if (msg.type === "broadcast:status") {
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

    if (msg.type === "listen:start") {
      const target = normalizeFlatId(msg.targetFlat);
      const st = live.stations.get(target);
      if (!st) return;

      if (client.role === "broadcaster") return;

      if (client.listeningTo && client.listeningTo !== target) {
        live.stations.get(client.listeningTo)?.listeners.delete(ws);
      }

      client.role = "listener";
      client.listeningTo = target;
      st.listeners.add(ws);
      return;
    }

    if (msg.type === "listen:stop") {
      if (client.listeningTo) {
        live.stations.get(client.listeningTo)?.listeners.delete(ws);
      }
      client.role = "idle";
      client.listeningTo = null;
      return;
    }
  });

  ws.on("close", () => {
    try { clearInterval(hb); } catch { }
    const c = live.clients.get(ws);
    if (!c) return;

    if (c.listeningTo) {
      live.stations.get(c.listeningTo)?.listeners.delete(ws);
    }

    if (c.role === "broadcaster" && c.flat_id) {
      const st = live.stations.get(c.flat_id);
      if (st) {
        for (const sock of st.listeners) {
          const lc = live.clients.get(sock);
          if (lc) {
            lc.role = "idle";
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
  return crypto.randomBytes(8).toString("hex");
}

wssSignal.on("connection", (ws, req) => {
  const ip = getIP(req);

  const sc = {
    id: makeId(),
    flat_id: null,
    ip,
    role: "unknown", // broadcaster | listener
    listeningTo: null
  };
  signalClients.set(ws, sc);

  // ✅ Heartbeat for signaling WS too
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const hb2 = setInterval(() => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { }
      clearInterval(hb2);
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { }
  }, 15000);


  safeSend(ws, { type: "hello", id: sc.id });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "identify") {
      sc.flat_id = normalizeFlatId(msg.flat_id);
      sc.role = msg.role === "broadcaster" ? "broadcaster" : "listener";

      if (sc.role === "broadcaster") {
        // 🔒 If a broadcaster signal ws already exists for this flat, do not replace it
        if (!stationBroadcasterWS.has(sc.flat_id)) {
          stationBroadcasterWS.set(sc.flat_id, ws);
        } else {
          safeSend(ws, { type: "broadcast:denied", reason: "ALREADY_BROADCASTING" });
          try { ws.close(1008, "already broadcasting"); } catch { }
        }
      }
      return;

    }

    if (msg.type === "listen:join") {
      const targetFlat = normalizeFlatId(msg.targetFlat);
      sc.role = "listener";
      sc.listeningTo = targetFlat;

      const st = live.stations.get(targetFlat);
      if (!st) {
        safeSend(ws, { type: "listen:error", error: "STATION_OFFLINE" });
        return;
      }

      const bws = stationBroadcasterWS.get(targetFlat);
      if (!bws) {
        safeSend(ws, { type: "listen:error", error: "BROADCASTER_SIGNAL_NOT_READY" });
        return;
      }

      safeSend(bws, { type: "listener:join", listenerId: sc.id });
      safeSend(ws, { type: "listen:ok", targetFlat });
      return;
    }

    if (msg.type === "listen:leave") {
      if (!sc.listeningTo) return;
      const target = sc.listeningTo;
      sc.listeningTo = null;

      const bws = stationBroadcasterWS.get(target);
      if (bws) safeSend(bws, { type: "listener:leave", listenerId: sc.id });
      return;
    }

    if (msg.type === "webrtc:offer") {
      const listenerWs = [...signalClients.entries()].find(([w, c]) => c.id === msg.listenerId)?.[0];
      if (!listenerWs) return;
      safeSend(listenerWs, { type: "webrtc:offer", from: sc.id, sdp: msg.sdp });
      return;
    }

    if (msg.type === "webrtc:answer") {
      const bws = stationBroadcasterWS.get(normalizeFlatId(msg.broadcasterFlat));
      if (!bws) return;
      safeSend(bws, { type: "webrtc:answer", listenerId: sc.id, sdp: msg.sdp });
      return;
    }

    if (msg.type === "webrtc:ice") {
      if (sc.role === "broadcaster" && msg.listenerId) {
        const listenerWs = [...signalClients.entries()].find(([w, c]) => c.id === msg.listenerId)?.[0];
        if (!listenerWs) return;
        safeSend(listenerWs, { type: "webrtc:ice", from: sc.id, candidate: msg.candidate });
        return;
      }

      if (sc.role === "listener" && msg.broadcasterFlat) {
        const bws = stationBroadcasterWS.get(normalizeFlatId(msg.broadcasterFlat));
        if (!bws) return;
        safeSend(bws, { type: "webrtc:ice", listenerId: sc.id, candidate: msg.candidate });
        return;
      }
    }
  });

  ws.on("close", () => {
    try { clearInterval(hb2); } catch { }

    const c = signalClients.get(ws);
    if (!c) return;

    if (c.role === "broadcaster" && c.flat_id) {
      if (stationBroadcasterWS.get(c.flat_id) === ws) {
        stationBroadcasterWS.delete(c.flat_id);
      }
    }

    signalClients.delete(ws);
  });
});
