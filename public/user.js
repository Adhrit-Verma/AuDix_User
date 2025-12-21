(() => {
  const byId = (id) => document.getElementById(id);

  // ---------- HTTP helpers ----------
  async function get(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) throw new Error('BAD_RESPONSE');
    const data = await res.json();
    if (!res.ok || data?.ok === false) throw new Error(data?.error || 'ERR');
    return data;
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) throw new Error('BAD_RESPONSE');
    const data = await res.json();
    if (!res.ok || data?.ok === false) throw new Error(data?.error || 'ERR');
    return data;
  }

  function setMsg(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('err', 'ok');
    if (type === 'err') el.classList.add('err');
    if (type === 'ok') el.classList.add('ok');
  }

  // ---------- INDEX (optional: request access quick) ----------
  async function initIndex() {
    if (window.location.pathname !== '/') return;

    const flatEl = byId('reg_flat_id');
    const nameEl = byId('reg_name');
    const btn = byId('btnReq');
    const msgEl = byId('msgReg');

    if (!btn) return;

    btn.addEventListener('click', async () => {
      setMsg(msgEl, 'Submitting request...');
      try {
        await post('/api/request-access', {
          flat_id: (flatEl?.value || '').trim(),
          name: (nameEl?.value || '').trim()
        });
        setMsg(msgEl, 'Request submitted. Ask admin to approve.', 'ok');
      } catch (e) {
        setMsg(msgEl, `Error: ${e.message}`, 'err');
      }
    });
  }

  // ---------- LOGIN ----------
  async function initLogin() {
    if (window.location.pathname !== '/login') return;

    const flatEl = byId('login_flat_id');
    const pinEl = byId('login_pin4');
    const passEl = byId('login_password');
    const rememberEl = byId('login_remember');
    const btnLogin = byId('btnLogin');
    const msgEl = byId('msgLogin');

    if (!btnLogin) return;

    btnLogin.addEventListener('click', async () => {
      setMsg(msgEl, 'Logging in...');
      try {
        const flat_id = (flatEl?.value || '').trim();
        const pin4 = (pinEl?.value || '').trim();
        const password = (passEl?.value || '').trim();
        const remember = rememberEl?.checked ? '1' : '0';

        await post('/api/login', { flat_id, pin4, password, remember });
        window.location.href = '/app';
      } catch (e) {
        setMsg(msgEl, `Error: ${e.message}`, 'err');
      }
    });
  }

  // ---------- SETUP (3-step wizard) ----------
  async function initSetup() {
    if (window.location.pathname !== '/setup') return;

    const step1 = byId('step1');
    const step2 = byId('step2');
    const step3 = byId('step3');

    const s1state = byId('s1state');
    const s2state = byId('s2state');
    const s3state = byId('s3state');

    const msgS1 = byId('msgS1');
    const msgS2 = byId('msgS2');
    const msgS3 = byId('msgS3');

    const s1flat = byId('s1_flat');
    const s1name = byId('s1_name');
    const btnS1 = byId('btnS1');

    const btnCheck = byId('btnCheck');

    const s3flat = byId('s3_flat');
    const s3code = byId('s3_code');
    const s3pin4 = byId('s3_pin4');
    const s3pass = byId('s3_pass');
    const btnS3 = byId('btnS3');

    function lockStep(stepEl, stateEl, text) {
      stepEl?.classList.add('disabled');
      if (stateEl) stateEl.textContent = text || 'Locked';
    }
    function unlockStep(stepEl, stateEl, text) {
      stepEl?.classList.remove('disabled');
      if (stateEl) stateEl.textContent = text || 'Ready';
    }

    // initial UI
    unlockStep(step1, s1state, 'Required');
    lockStep(step2, s2state, 'Locked');
    lockStep(step3, s3state, 'Locked');

    btnS1?.addEventListener('click', async () => {
      setMsg(msgS1, 'Submitting request...');
      try {
        await post('/api/request-access', {
          flat_id: (s1flat?.value || '').trim(),
          name: (s1name?.value || '').trim()
        });
        setMsg(msgS1, 'Request submitted. Ask admin to approve.', 'ok');
        unlockStep(step2, s2state, 'Check status');
      } catch (e) {
        setMsg(msgS1, `Error: ${e.message}`, 'err');
      }
    });

    btnCheck?.addEventListener('click', async () => {
      const flat = (s1flat?.value || s3flat?.value || '').trim();
      if (!flat) {
        setMsg(msgS2, 'Enter Flat ID in Step 1 or Step 3 first.', 'err');
        return;
      }

      setMsg(msgS2, 'Checking status...');
      try {
        const st = await get(`/api/setup-status?flat_id=${encodeURIComponent(flat)}`);

        const reqStatus = st?.request?.status || 'NONE';
        const flatStatus = st?.flat?.status || 'NOT_CREATED';

        // show a helpful message
        if (!st.request) {
          setMsg(msgS2, 'No request found. Submit Step 1 first.', 'err');
          lockStep(step3, s3state, 'Locked');
          return;
        }

        if (reqStatus === 'PENDING') {
          setMsg(msgS2, 'Still pending. Ask admin to approve your request.', 'err');
          lockStep(step3, s3state, 'Locked');
          return;
        }

        if (reqStatus === 'REJECTED') {
          setMsg(msgS2, 'Request rejected. Ask admin to review.', 'err');
          lockStep(step3, s3state, 'Locked');
          return;
        }

        if (reqStatus === 'APPROVED' && flatStatus === 'ACTIVE') {
          setMsg(msgS2, 'Approved. Ask admin for your one-time flat code. Step 3 unlocked.', 'ok');
          unlockStep(step3, s3state, 'Ready');
          if (s3flat) s3flat.value = flat;
          return;
        }

        setMsg(msgS2, `Status: request=${reqStatus}, flat=${flatStatus}.`, 'err');
      } catch (e) {
        setMsg(msgS2, `Error: ${e.message}`, 'err');
      }
    });

    btnS3?.addEventListener('click', async () => {
      setMsg(msgS3, 'Setting PIN...');
      try {
        await post('/api/setup-pin', {
          flat_id: (s3flat?.value || '').trim(),
          code: (s3code?.value || '').trim(),
          pin4: (s3pin4?.value || '').trim(),
          password: (s3pass?.value || '').trim()
        });

        setMsg(msgS3, 'PIN saved. Redirecting to login...', 'ok');
        setTimeout(() => (window.location.href = '/login'), 700);
      } catch (e) {
        setMsg(msgS3, `Error: ${e.message}`, 'err');
      }
    });
  }

  // ---------- APP (Live stations + WebRTC audio) ----------
  async function initApp() {
    if (window.location.pathname !== '/app') return;

    const meEl = byId('me');
    const listEl = byId('list');
    const msgEl = byId('msg');
    const statusEl = byId('myStatus');
    const hintEl = byId('hint');
    const logoutBtn = byId('logoutBtn');

    const btnStart = byId('btnStart');
    const btnStop = byId('btnStop');

    const micEnableEl = byId('micEnable');
    const sysEnableEl = byId('sysEnable');
    const pttEnableEl = byId('pttEnable');
    const btnSysPick = byId('btnSysPick');
    const micLevelEl = byId('micLevel');
    const sysLevelEl = byId('sysLevel');
    const btnHoldTalk = byId('btnHoldTalk');
    const player = byId('player');
    const sysSelectedEl = byId('sysSelected');
    const micLevelValEl = byId('micLevelVal');
    const sysLevelValEl = byId('sysLevelVal');
    const timerEl = byId('timer');
    const listenStatusEl = byId('listenStatus');

    function updateLevelLabels() {
      if (micLevelValEl) micLevelValEl.textContent = `${Number(micLevelEl?.value || 0)}%`;
      if (sysLevelValEl) sysLevelValEl.textContent = `${Number(sysLevelEl?.value || 0)}%`;
    }
    micLevelEl?.addEventListener('input', updateLevelLabels);
    sysLevelEl?.addEventListener('input', updateLevelLabels);
    updateLevelLabels();


    const setMsgLocal = (t) => setMsg(msgEl, t);

    const state = {
      myFlat: null,
      myMode: 'idle',  // idle | broadcasting
      wsReady: false,
      busy: false
    };

    // --- WebRTC signal/mix state ---
    const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

    let signalWS = null;

    // broadcaster side
    let mixedStream = null;
    let micStream = null;
    let sysStream = null;
    let audioCtx = null;
    let micGain = null;
    let sysGain = null;
    let dest = null;
    const pcs = new Map(); // listenerId -> RTCPeerConnection

    // listener side
    let listenPC = null;
    let listeningTo = null;

    function wsProto() {
      return location.protocol === 'https:' ? 'wss' : 'ws';
    }

    function ensureSignalWS(role) {
      return new Promise((resolve, reject) => {
        if (signalWS && signalWS.readyState === 1) return resolve();

        signalWS = new WebSocket(`${wsProto()}://${location.host}/ws/signal`);

        signalWS.onopen = () => {
          signalWS.send(JSON.stringify({ type: 'identify', flat_id: state.myFlat, role }));
          resolve();
        };

        signalWS.onerror = () => reject(new Error('SIGNAL_WS_ERROR'));
        signalWS.onmessage = (ev) => onSignalMessage(ev);
      });
    }

    function onSignalMessage(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'listener:join') return onListenerJoin(msg.listenerId);
      if (msg.type === 'listener:leave') return onListenerLeave(msg.listenerId);

      if (msg.type === 'webrtc:offer') return onOfferFromBroadcaster(msg);
      if (msg.type === 'webrtc:answer') return onAnswerFromListener(msg);
      if (msg.type === 'webrtc:ice') return onRemoteIce(msg);
    }

    function micSliderGain() { return (Number(micLevelEl?.value || 100) / 100); }
    function sysSliderGain() { return (Number(sysLevelEl?.value || 70) / 100); }

    async function ensureMic() {
      if (micStream) return;
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    async function pickSystemAudio() {
      const ds = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      const a = ds.getAudioTracks()[0];
      if (!a) throw new Error('NO_SYSTEM_AUDIO_TRACK');

      // Stop video tracks immediately
      ds.getVideoTracks().forEach(t => t.stop());

      // Store stream (only audio track)
      sysStream = new MediaStream([a]);

      // Show label
      const label = a.label || 'System audio';
      if (sysSelectedEl) sysSelectedEl.textContent = `System audio: ${label}`;
      if (sysSelectedEl) sysSelectedEl.textContent = 'System audio: Not selected';
    }

    let broadcastStartedAt = null;
    let timerInterval = null;

    function startTimer() {
      broadcastStartedAt = Date.now();
      stopTimer();
      timerInterval = setInterval(() => {
        const ms = Date.now() - broadcastStartedAt;
        const s = Math.floor(ms / 1000);
        const hh = String(Math.floor(s / 3600)).padStart(2, '0');
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        if (timerEl) timerEl.textContent = `${hh}:${mm}:${ss}`;
      }, 250);
    }

    function stopTimer() {
      if (timerInterval) clearInterval(timerInterval);
      timerInterval = null;
      if (timerEl) timerEl.textContent = '00:00:00';
    }



    function buildMixer() {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      dest = audioCtx.createMediaStreamDestination();

      micGain = audioCtx.createGain();
      sysGain = audioCtx.createGain();

      micGain.gain.value = micSliderGain();
      sysGain.gain.value = sysSliderGain();

      if (micStream) {
        const src = audioCtx.createMediaStreamSource(micStream);
        src.connect(micGain).connect(dest);
      }
      if (sysStream) {
        const src = audioCtx.createMediaStreamSource(sysStream);
        src.connect(sysGain).connect(dest);
      }

      if (pttEnableEl?.checked) micGain.gain.value = 0; // start muted for PTT
      mixedStream = dest.stream;
    }

    function teardownMixerAndStopTracks() {
      // Close peer connections
      pcs.forEach(pc => pc.close());
      pcs.clear();

      // Stop mixed stream tracks (safety)
      if (mixedStream) mixedStream.getTracks().forEach(t => t.stop());
      mixedStream = null;

      // Close audio context
      if (audioCtx) audioCtx.close().catch(() => { });
      audioCtx = null;
      dest = null;
      micGain = null;
      sysGain = null;

      // STOP mic capture
      if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
      }

      // STOP system audio capture
      if (sysStream) {
        sysStream.getTracks().forEach(t => t.stop());
        sysStream = null;
      }

      // Reset labels
      if (sysSelectedEl) sysSelectedEl.textContent = 'System audio: Not selected';
    }


    function setGainsFromUI() {
      if (micGain && !pttEnableEl?.checked) micGain.gain.value = micEnableEl?.checked ? micSliderGain() : 0;
      if (sysGain) sysGain.gain.value = sysEnableEl?.checked ? sysSliderGain() : 0;
    }

    micLevelEl?.addEventListener('input', setGainsFromUI);
    sysLevelEl?.addEventListener('input', setGainsFromUI);
    micEnableEl?.addEventListener('change', setGainsFromUI);
    sysEnableEl?.addEventListener('change', setGainsFromUI);

    pttEnableEl?.addEventListener('change', () => {
      if (!micGain) return;
      if (pttEnableEl.checked) micGain.gain.value = 0;
      else micGain.gain.value = micEnableEl?.checked ? micSliderGain() : 0;
    });

    btnSysPick?.addEventListener('click', async () => {
      try {
        await pickSystemAudio();
        setMsgLocal('System audio selected.');
      } catch (e) {
        setMsgLocal(`System audio failed: ${e.message}`);
      }
    });

    function pttDown() {
      if (!micGain) return;
      if (!pttEnableEl?.checked) return;
      micGain.gain.value = micEnableEl?.checked ? micSliderGain() : 0;
    }
    function pttUp() {
      if (!micGain) return;
      if (!pttEnableEl?.checked) return;
      micGain.gain.value = 0;
    }

    window.addEventListener('keydown', (e) => { if (e.code === 'Space') pttDown(); });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') pttUp(); });

    btnHoldTalk?.addEventListener('pointerdown', () => pttDown());
    btnHoldTalk?.addEventListener('pointerup', () => pttUp());
    btnHoldTalk?.addEventListener('pointercancel', () => pttUp());
    btnHoldTalk?.addEventListener('pointerleave', () => pttUp());

    async function onListenerJoin(listenerId) {
      if (!mixedStream) return;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcs.set(listenerId, pc);

      mixedStream.getTracks().forEach(track => pc.addTrack(track, mixedStream));

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        signalWS?.send(JSON.stringify({ type: 'webrtc:ice', listenerId, candidate: ev.candidate }));
      };

      const offer = await pc.createOffer({ offerToReceiveAudio: false });
      await pc.setLocalDescription(offer);

      signalWS?.send(JSON.stringify({ type: 'webrtc:offer', listenerId, sdp: pc.localDescription }));
    }

    function onListenerLeave(listenerId) {
      const pc = pcs.get(listenerId);
      if (pc) pc.close();
      pcs.delete(listenerId);
    }

    async function onAnswerFromListener(msg) {
      const pc = pcs.get(msg.listenerId);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }

    async function startListening(targetFlat) {
      // only one station at a time
      if (listeningTo && listeningTo !== targetFlat) await stopListening();

      listeningTo = targetFlat;

      await ensureSignalWS('listener');

      listenPC = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      listenPC.ontrack = (ev) => {
        if (player) player.srcObject = ev.streams[0];
      };

      listenPC.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        signalWS?.send(JSON.stringify({ type: 'webrtc:ice', broadcasterFlat: targetFlat, candidate: ev.candidate }));
      };

      signalWS?.send(JSON.stringify({ type: 'listen:join', targetFlat }));
    }


    async function stopListening() {
      if (signalWS && signalWS.readyState === 1 && listeningTo) {
        signalWS.send(JSON.stringify({ type: 'listen:leave' }));
      }
      if (listenPC) {
        listenPC.close();
        listenPC = null;
      }
      listeningTo = null;
      if (player) player.srcObject = null;
    }

    async function onOfferFromBroadcaster(msg) {
      if (!listenPC || !listeningTo) return;

      await listenPC.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await listenPC.createAnswer();
      await listenPC.setLocalDescription(answer);

      signalWS?.send(JSON.stringify({
        type: 'webrtc:answer',
        broadcasterFlat: listeningTo,
        sdp: listenPC.localDescription
      }));
    }

    async function onRemoteIce(msg) {
      // broadcaster receives ICE from listener
      if (msg.listenerId) {
        const pc = pcs.get(msg.listenerId);
        if (!pc) return;
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { }
        return;
      }

      // listener receives ICE from broadcaster
      if (listenPC && msg.candidate) {
        try { await listenPC.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { }
      }
    }

    let statusTimer = null;
    function startStatusLoop() {
      stopStatusLoop();
      statusTimer = setInterval(() => {
        if (!window.audixWS || window.audixWS.readyState !== 1) return;
        if (state.myMode !== 'broadcasting') return;

        const speaking = !!(pttEnableEl?.checked ? (micGain && micGain.gain.value > 0.01) : false);

        window.audixWS.send(JSON.stringify({
          type: 'broadcast:status',
          micOn: !!micEnableEl?.checked,
          sysOn: !!sysEnableEl?.checked,
          ptt: !!pttEnableEl?.checked,
          speaking,
          micLevel: micGain ? Number(micGain.gain.value.toFixed(2)) : 0
        }));
      }, 500);
      startTimer();
    }
    function stopStatusLoop() {
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
    }

    function renderSelf() {
      if (meEl) meEl.textContent = state.myFlat ? `You: ${state.myFlat}` : 'You: -';

      const isLive = state.myMode === 'broadcasting';
      const connected = state.wsReady === true;

      if (statusEl) {
        statusEl.textContent = `Status: ${isLive ? 'LIVE (Broadcasting)' : 'Not live'}`;
        statusEl.style.fontWeight = '800';
      }

      const pill = byId('livePill');
      if (pill) {
        pill.textContent = isLive ? 'LIVE' : 'OFF';
        pill.classList.remove('pillOff', 'pillLive');
        pill.classList.add(isLive ? 'pillLive' : 'pillOff');
      }

      if (btnStart) btnStart.disabled = !connected || isLive;
      if (btnStop) btnStop.disabled = !connected || !isLive;

      if (hintEl) {
        if (!connected) hintEl.textContent = 'Connecting...';
        else if (isLive) hintEl.textContent = 'You are live now.';
        else hintEl.textContent = 'Start broadcast to go live.';
      }
    }

    function renderStations(stations) {
      if (!listEl) return;

      const others = (stations || []).filter(s => s.id !== state.myFlat);

      const youLiveRow = state.myMode === 'broadcasting'
        ? `
          <div class="item" style="display:flex; justify-content:space-between; gap:12px; border:1px solid #eee;">
            <div>
              <b>${state.myFlat}</b>
              <div class="small">This is your station</div>
            </div>
            <div><b>LIVE</b></div>
          </div>
        `
        : '';

      if (!others.length) {
        listEl.innerHTML = `${youLiveRow}<div class="item">No other stations are live right now.</div>`;
      } else {
        listEl.innerHTML = youLiveRow + others.map(s => `
          <div class="item" style="display:flex; justify-content:space-between; gap:12px; align-items:center;">
            <div>
              <b>${s.name}</b>
              <div class="small">${s.listeners} listening</div>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn" data-listen="${s.id}">
                ${listeningTo === s.id ? 'Listening' : 'Listen'}
              </button>
              ${listeningTo === s.id ? `<button class="btn" data-stoplisten="1">Stop</button>` : ``}
            </div>
          </div>
        `).join('');
      }

      // attach handlers AFTER rendering
      listEl.querySelectorAll('button[data-listen]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const target = btn.getAttribute('data-listen');
          if (!target) return;
          await startListening(target);
          setMsgLocal(`Listening to ${target}`);
          refreshStations();
        });
      });

      listEl.querySelectorAll('button[data-stoplisten]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await stopListening();
          setMsgLocal('Stopped listening.');
          refreshStations();
        });
      });
    }

    logoutBtn?.addEventListener('click', async () => {
      try { await post('/api/logout', {}); } catch { }
      window.location.href = '/login';
    });

    // 1) Must be logged in
    try {
      const data = await get('/api/live');
      state.myFlat = data.flat_id;
      renderSelf();
    } catch {
      setMsgLocal('Session expired. Please login again.');
      window.location.href = '/login';
      return;
    }

    // 2) Presence WS
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      window.audixWS = new WebSocket(`${proto}://${location.host}/ws/presence`);

      window.audixWS.onopen = () => {
        state.wsReady = true;
        window.audixWS.send(JSON.stringify({ type: 'identify', flat_id: state.myFlat }));
        renderSelf();
      };

      window.audixWS.onclose = () => {
        state.wsReady = false;
        state.myMode = 'idle';
        renderSelf();
      };
    } catch {
      state.wsReady = false;
      renderSelf();
    }

    // 3) Broadcast buttons
    btnStart?.addEventListener('click', async () => {
      if (state.busy) return;
      if (!window.audixWS || window.audixWS.readyState !== 1) return;

      try {
        state.busy = true;

        // stop listening when going live
        await stopListening();

        if (micEnableEl?.checked) await ensureMic();
        if (sysEnableEl?.checked && !sysStream) {
          setMsgLocal('Pick system audio first (button).');
          return;
        }

        buildMixer();
        setGainsFromUI();

        await ensureSignalWS('broadcaster');

        window.audixWS.send(JSON.stringify({ type: 'broadcast:start' }));
        state.myMode = 'broadcasting';
        setMsgLocal('You are live now.');
        renderSelf();

        startStatusLoop();
      } catch (e) {
        setMsgLocal(`Broadcast failed: ${e.message}`);
      } finally {
        setTimeout(() => { state.busy = false; }, 300);
      }
    });

    btnStop?.addEventListener('click', async () => {
      if (state.busy) return;
      if (!window.audixWS || window.audixWS.readyState !== 1) return;

      state.busy = true;

      window.audixWS.send(JSON.stringify({ type: 'broadcast:stop' }));

      stopStatusLoop();
      teardownMixerAndStopTracks();
      stopTimer();


      state.myMode = 'idle';
      setMsgLocal('Broadcast stopped.');
      renderSelf();

      setTimeout(() => { state.busy = false; }, 300);
    });

    // 4) Poll station list
    async function refreshStations() {
      try {
        const data = await get('/api/live');
        renderStations(data.stations || []);
      } catch { }
    }

    refreshStations();
    setInterval(refreshStations, 2000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initIndex();
    initLogin();
    initSetup();
    initApp();
  });
})();
