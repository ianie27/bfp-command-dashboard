// server.js - Complete WebRTC Signaling Server
// Real-time bidirectional voice relay for dispatcher <-> mobile

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// ✅ FIX: Serve the built React app from dist/ (not public/)
// ============================================================
const DIST_DIR = path.join(__dirname, 'dist');
app.use(express.static(DIST_DIR));

// Also serve public/ if it exists (for favicon, robots.txt, etc.)
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// ---------------- Health ----------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeCalls: activeCalls.size,
    webrtcPeers: webrtcPeers.size,
    connectedClients: io?.engine?.clientsCount || 0,
  });
});

app.get('/api/calls', (req, res) => {
  const calls = Array.from(activeCalls.values()).map(call => ({
    callId: call.callId,
    callerName: call.userName,
    status: call.status,
    timestamp: call.timestamp,
    duration: call.connectedAt ? Math.round((Date.now() - call.connectedAt) / 1000) : 0,
  }));
  res.json({ calls, total: calls.length });
});

// ---------------- Server ----------------
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true,
  maxHttpBufferSize: 1e7,
});

// ---------------- State ----------------
const activeCalls = new Map();
const socketToCall = new Map();
const socketToUser = new Map();
const webrtcPeers = new Map();

// ---------------- Helpers ----------------
function broadcastEndCall(callId, options = {}) {
  const {
    dispatcherName = 'Dispatcher',
    dispatcherId = 'dispatcher',
    userName = 'caller',
    userId = '',
    extraData = {},
  } = options;

  const endCallData = {
    callId, dispatcherId, dispatcherName,
    dispatcherDisplayName: dispatcherName,
    endedBy: dispatcherName, ended_by: dispatcherName,
    userName, userId,
    timestamp: new Date().toISOString(),
    ...extraData,
  };

  const events = ['call_ended', 'call_ended_by_dispatcher', 'end_call', 'dispatcher_end_call'];
  events.forEach(e => io.to(`call_${callId}`).emit(e, endCallData));
  io.to('dispatcher_room').emit('call_ended', endCallData);

  const call = activeCalls.get(callId);
  if (call && call.callerSocketId) {
    const callerSocket = io.sockets.sockets.get(call.callerSocketId);
    if (callerSocket) {
      events.forEach(e => callerSocket.emit(e, endCallData));
      callerSocket.emit('webrtc_call_ended', {
        callId, endedBy: 'dispatcher', timestamp: new Date().toISOString(),
      });
    }
  }

  const peers = webrtcPeers.get(callId) || {};
  [peers.callerSocketId, peers.dispatcherSocketId].forEach(sid => {
    if (sid && io.sockets.sockets.get(sid)) {
      io.to(sid).emit('webrtc_call_ended', {
        callId, endedBy: 'dispatcher', timestamp: new Date().toISOString(),
      });
    }
  });

  if (call) {
    call.status = 'ended';
    call.endedAt = Date.now();
    activeCalls.set(callId, call);
  }
  webrtcPeers.delete(callId);
  scheduleCallCleanup(callId);
}

function broadcastCallerEndedCall(callId, options = {}) {
  const {
    userName = 'caller', userId = '', callerName = 'caller', extraData = {},
  } = options;

  const endData = {
    callId,
    endedBy: 'caller', ended_by: 'caller',
    endedByName: callerName || userName,
    ended_by_name: callerName || userName,
    userName: callerName || userName, userId,
    timestamp: new Date().toISOString(),
    ...extraData,
  };

  const events = ['call_ended', 'call_ended_by_caller', 'caller_ended_call', 'caller_end_call', 'end_call_by_caller'];
  events.forEach(e => io.to('dispatcher_room').emit(e, endData));
  events.forEach(e => io.to(`call_${callId}`).emit(e, endData));

  io.to('dispatcher_room').emit('webrtc_call_ended', {
    callId, endedBy: 'caller', timestamp: new Date().toISOString(),
  });

  const call = activeCalls.get(callId);
  if (call) {
    call.status = 'ended';
    call.endedAt = Date.now();
    activeCalls.set(callId, call);
  }
  webrtcPeers.delete(callId);
  scheduleCallCleanup(callId);
}

function scheduleCallCleanup(callId) {
  setTimeout(() => {
    const call = activeCalls.get(callId);
    if (call && ['ended', 'disconnected', 'dismissed'].includes(call.status)) {
      activeCalls.delete(callId);
      webrtcPeers.delete(callId);
      io.socketsLeave(`call_${callId}`);
      io.socketsLeave(callId);
    }
  }, 5000);
}

// ⭐ Force-mark call as connected and broadcast to BOTH peers
function markCallConnected(callId) {
  const call = activeCalls.get(callId);
  if (!call) {
    console.log(`⚠️ markCallConnected: no call ${callId}`);
    return;
  }

  if (call.status === 'connected') {
    console.log(`🔗 Call ${callId} already connected`);
    return;
  }

  call.status = 'connected';
  call.connectedAt = Date.now();
  activeCalls.set(callId, call);

  const connectedData = {
    callId, status: 'connected',
    connectedAt: call.connectedAt,
    timestamp: new Date().toISOString(),
  };

  console.log(`🔗🔗🔗 MARKING CALL ${callId} CONNECTED`);

  io.to(`call_${callId}`).emit('call_connected', connectedData);
  io.to('dispatcher_room').emit('call_connected', connectedData);

  const peers = webrtcPeers.get(callId) || {};
  if (peers.callerSocketId) {
    io.to(peers.callerSocketId).emit('call_connected', connectedData);
    console.log(`   → caller ${peers.callerSocketId}`);
  }
  if (peers.dispatcherSocketId) {
    io.to(peers.dispatcherSocketId).emit('call_connected', connectedData);
    console.log(`   → dispatcher ${peers.dispatcherSocketId}`);
  }
}

// ⭐ Find dispatcher for a call (from peer map, room, or dispatcher_room)
function findDispatcherSocket(callId, callerSocketId) {
  const peers = webrtcPeers.get(callId) || {};

  if (peers.dispatcherSocketId) {
    const s = io.sockets.sockets.get(peers.dispatcherSocketId);
    if (s && s.userType === 'dispatcher') return peers.dispatcherSocketId;
  }

  const room = io.sockets.adapter.rooms.get(`call_${callId}`);
  if (room) {
    for (const sid of room) {
      if (sid === callerSocketId) continue;
      const s = io.sockets.sockets.get(sid);
      if (s && s.userType === 'dispatcher') {
        peers.dispatcherSocketId = sid;
        webrtcPeers.set(callId, peers);
        return sid;
      }
    }
  }

  const dispatcherRoom = io.sockets.adapter.rooms.get('dispatcher_room');
  if (dispatcherRoom && dispatcherRoom.size > 0) {
    for (const sid of dispatcherRoom) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.userType === 'dispatcher') {
        peers.dispatcherSocketId = sid;
        webrtcPeers.set(callId, peers);
        s.join(`call_${callId}`);
        console.log(`📡 Dispatcher ${sid} auto-joined call room ${callId}`);
        return sid;
      }
    }
  }

  return null;
}

// ---------------- Socket.IO ----------------
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ---------------- Dispatcher ----------------
  socket.on('join_dispatcher', (data) => {
    const { userId, name, userName, displayName, fullName, dispatcherName } = data || {};
    socket.join('dispatcher_room');
    socket.dispatcherId = userId;
    socket.dispatcherName = name || userName || displayName || fullName || dispatcherName || 'Dispatcher';
    socket.userType = 'dispatcher';
    socketToUser.set(socket.id, userId);
    console.log(`📡 Dispatcher ${socket.dispatcherName} joined`);
  });

  // ---------------- Caller ----------------
  socket.on('join_caller', (data) => {
    const { callId, userId, userName, phone, latitude, longitude, address } = data || {};
    socket.join(`call_${callId}`);
    socket.callId = callId;
    socket.callerId = userId;
    socket.userName = userName || 'Citizen';
    socket.userType = 'caller';
    socketToCall.set(socket.id, callId);

    activeCalls.set(callId, {
      callId, userId,
      userName: userName || 'Citizen',
      phone: phone || 'Unknown',
      latitude: latitude || 0,
      longitude: longitude || 0,
      address: address || '',
      status: 'ringing',
      callerSocketId: socket.id,
      dispatcherSocketId: null,
      timestamp: Date.now(),
    });

    const peers = webrtcPeers.get(callId) || {};
    peers.callerSocketId = socket.id;
    webrtcPeers.set(callId, peers);

    io.to('dispatcher_room').emit('incoming_call', {
      callId,
      caller_name: userName || 'Citizen',
      caller_phone: phone || 'Unknown',
      latitude, longitude, address,
      timestamp: Date.now(),
      callerSocketId: socket.id,
    });

    console.log(`📞 Incoming emergency ${callId} from ${userName}`);
  });

  socket.on('join_call', (data) => {
    const { callId, userId, userName } = data || {};
    if (!callId) return;

    socket.join(`call_${callId}`);
    socket.join(callId);
    socket.callId = callId;
    socketToCall.set(socket.id, callId);

    if (userId) {
      socket.join(`user_${userId}`);
      socketToUser.set(socket.id, userId);
    }

    if (socket.userType === 'caller' || !socket.userType) {
      socket.userType = 'caller';
      const peers = webrtcPeers.get(callId) || {};
      peers.callerSocketId = socket.id;
      webrtcPeers.set(callId, peers);

      const call = activeCalls.get(callId);
      if (call && !call.callerSocketId) {
        call.callerSocketId = socket.id;
        activeCalls.set(callId, call);
      }
    }

    socket.emit('joined_call', { callId, success: true });
    console.log(`✅ Socket ${socket.id} joined call ${callId} (type=${socket.userType})`);
  });

  // ---------------- Acknowledge ----------------
  socket.on('acknowledge_call', (data) => {
    const { callId, dispatcherId, dispatcherName } = data || {};
    console.log(`✅ Acknowledge ${callId} by ${dispatcherName}`);

    socket.userType = 'dispatcher';
    socket.dispatcherId = dispatcherId;
    socket.dispatcherName = dispatcherName;

    const call = activeCalls.get(callId);
    if (!call) {
      socket.emit('error', { message: 'Call not found' });
      return;
    }

    call.status = 'acknowledged';
    call.dispatcherId = dispatcherId;
    call.dispatcherName = dispatcherName;
    call.acknowledgedAt = Date.now();
    call.dispatcherSocketId = socket.id;
    activeCalls.set(callId, call);

    const peers = webrtcPeers.get(callId) || {};
    peers.dispatcherSocketId = socket.id;
    if (call.callerSocketId) peers.callerSocketId = call.callerSocketId;
    webrtcPeers.set(callId, peers);

    socket.join(`call_${callId}`);
    socket.join(callId);
    socketToCall.set(socket.id, callId);

    if (call.callerSocketId) {
      const callerSocket = io.sockets.sockets.get(call.callerSocketId);
      if (callerSocket) {
        callerSocket.join(`call_${callId}`);
        callerSocket.join(callId);
      }
    }

    const ackData = { callId, dispatcherId, dispatcherName, acknowledgedAt: Date.now() };
    io.to(`call_${callId}`).emit('call_acknowledged', ackData);
    io.to('dispatcher_room').emit('call_acknowledged', ackData);
    console.log(`📞 Peers: caller=${peers.callerSocketId} dispatcher=${peers.dispatcherSocketId}`);
  });

  // ============================================================
  // WEBRTC SIGNALING
  // ============================================================
  socket.on('request_webrtc_offer', (data) => {
    const { callId, attempt } = data || {};
    if (!callId) return;

    console.log(`📤 request_webrtc_offer for ${callId} from ${socket.id} (${socket.userType || 'unknown'}, attempt=${attempt || 1})`);

    const peers = webrtcPeers.get(callId) || {};

    if (socket.userType === 'caller' || !socket.userType) {
      socket.userType = 'caller';
      peers.callerSocketId = socket.id;
      webrtcPeers.set(callId, peers);
    }

    socket.join(`call_${callId}`);

    const dispatcherSocketId = findDispatcherSocket(callId, socket.id);

    const payload = {
      callId,
      from: 'mobile',
      fromSocketId: socket.id,
      callerName: socket.userName,
      ready: true,
      attempt: attempt || 1,
    };

    if (dispatcherSocketId) {
      io.to(dispatcherSocketId).emit('request_webrtc_offer', payload);
      console.log(`📤 request_webrtc_offer → dispatcher ${dispatcherSocketId}`);
    } else {
      io.to('dispatcher_room').emit('request_webrtc_offer', payload);
      console.log(`📤 request_webrtc_offer → dispatcher_room (broadcast)`);
    }
  });

  socket.on('webrtc_offer', (data) => {
    const { callId, offer, from, targetSocketId } = data || {};
    if (!callId || !offer) return;

    // ⭐ Log SDP to verify audio
    if (offer.sdp) {
      const hasAudio = offer.sdp.includes('m=audio');
      const hasOpus = offer.sdp.includes('opus');
      console.log(`📤 offer SDP: hasAudio=${hasAudio}, hasOpus=${hasOpus}`);
    }

    const peers = webrtcPeers.get(callId) || {};
    if (socket.userType === 'caller') peers.callerSocketId = socket.id;
    if (socket.userType === 'dispatcher') peers.dispatcherSocketId = socket.id;
    webrtcPeers.set(callId, peers);

    let targetId = targetSocketId;
    if (!targetId) {
      targetId = socket.userType === 'dispatcher'
        ? peers.callerSocketId
        : peers.dispatcherSocketId;
    }

    console.log(`📤 offer: ${socket.userType}(${socket.id}) → ${targetId} [${callId}]`);

    if (targetId) {
      io.to(targetId).emit('webrtc_offer', {
        callId, offer, from: from || socket.userType, fromSocketId: socket.id,
      });
    } else {
      socket.to(`call_${callId}`).emit('webrtc_offer', {
        callId, offer, from: from || socket.userType, fromSocketId: socket.id,
      });
    }

    const call = activeCalls.get(callId);
    if (call && call.status !== 'connected' && call.status !== 'connecting') {
      call.status = 'connecting';
      activeCalls.set(callId, call);
    }
  });

  socket.on('webrtc_answer', (data) => {
    const { callId, answer, from, targetSocketId } = data || {};
    if (!callId || !answer) return;

    // ⭐ Log SDP to verify audio
    if (answer.sdp) {
      const hasAudio = answer.sdp.includes('m=audio');
      const hasOpus = answer.sdp.includes('opus');
      console.log(`📥 answer SDP: hasAudio=${hasAudio}, hasOpus=${hasOpus}`);
    }

    console.log(`📥📥📥 webrtc_answer: callId=${callId}, from=${from || socket.userType}`);

    const peers = webrtcPeers.get(callId) || {};
    if (socket.userType === 'caller') peers.callerSocketId = socket.id;
    if (socket.userType === 'dispatcher') peers.dispatcherSocketId = socket.id;
    webrtcPeers.set(callId, peers);

    let targetId = targetSocketId;
    if (!targetId) {
      targetId = socket.userType === 'dispatcher'
        ? peers.callerSocketId
        : peers.dispatcherSocketId;
    }

    console.log(`📥 Relaying answer to: ${targetId}`);

    if (targetId) {
      io.to(targetId).emit('webrtc_answer', {
        callId, answer, from: from || socket.userType, fromSocketId: socket.id,
      });
    } else {
      socket.to(`call_${callId}`).emit('webrtc_answer', {
        callId, answer, from: from || socket.userType, fromSocketId: socket.id,
      });
    }

    markCallConnected(callId);
  });

  socket.on('webrtc_ice_candidate', (data) => {
    const { callId, candidate, from, targetSocketId } = data || {};
    if (!callId || !candidate) return;

    const peers = webrtcPeers.get(callId) || {};
    let targetId = targetSocketId;
    if (!targetId) {
      targetId = socket.userType === 'dispatcher'
        ? peers.callerSocketId
        : peers.dispatcherSocketId;
    }

    if (targetId) {
      io.to(targetId).emit('webrtc_ice_candidate', {
        callId, candidate, from: from || socket.userType, fromSocketId: socket.id,
      });
    } else {
      socket.to(`call_${callId}`).emit('webrtc_ice_candidate', {
        callId, candidate, from: from || socket.userType, fromSocketId: socket.id,
      });
    }
  });

  socket.on('webrtc_connected', (data) => {
    const { callId } = data || {};
    if (!callId) return;
    console.log(`🔗 webrtc_connected for ${callId} from ${socket.userType}`);
    markCallConnected(callId);
  });

  socket.on('webrtc_ready', (data) => {
    const { callId } = data || {};
    if (!callId) return;
    console.log(`🔗 webrtc_ready for ${callId} from ${socket.userType}`);

    const peers = webrtcPeers.get(callId) || {};
    if (socket.userType === 'caller') peers.callerSocketId = socket.id;
    if (socket.userType === 'dispatcher') peers.dispatcherSocketId = socket.id;
    webrtcPeers.set(callId, peers);

    if (peers.callerSocketId && peers.dispatcherSocketId) {
      markCallConnected(callId);
    }
  });

  socket.on('webrtc_call_ended', (data) => {
    const { callId, endedBy } = data || {};
    if (!callId) return;
    console.log(`📞 webrtc_call_ended ${callId} by ${endedBy}`);

    const peers = webrtcPeers.get(callId) || {};
    [peers.callerSocketId, peers.dispatcherSocketId].forEach(tid => {
      if (tid && tid !== socket.id) {
        io.to(tid).emit('webrtc_call_ended', {
          callId, endedBy: endedBy || socket.userType, timestamp: new Date().toISOString(),
        });
      }
    });

    webrtcPeers.delete(callId);
    const call = activeCalls.get(callId);
    if (call) {
      call.status = 'ended';
      call.endedAt = Date.now();
      activeCalls.set(callId, call);
    }
    scheduleCallCleanup(callId);
  });

  // ---------------- End call (dispatcher) ----------------
  socket.on('end_call', (data) => {
    const { callId, ...rest } = data || {};
    if (!callId) return;
    broadcastEndCall(callId, {
      dispatcherName: data.dispatcherName || socket.dispatcherName || 'Dispatcher',
      dispatcherId: data.dispatcherId || socket.dispatcherId || 'dispatcher',
      userName: data.userName, userId: data.userId, extraData: rest,
    });
    socket.emit('dispatcher_end_call_ack', { callId, success: true });
  });

  socket.on('call_ended', (data) => {
    const { callId, ...rest } = data || {};
    if (!callId) return;
    const endedBy = rest.endedBy || rest.ended_by;
    if (endedBy === 'caller' || endedBy === 'user') {
      const call = activeCalls.get(callId);
      broadcastCallerEndedCall(callId, {
        userName: call?.userName || 'caller',
        userId: call?.userId || '',
        callerName: call?.userName || 'caller',
        extraData: rest,
      });
    } else {
      broadcastEndCall(callId, {
        dispatcherName: data.dispatcherName || socket.dispatcherName || 'Dispatcher',
        dispatcherId: data.dispatcherId || socket.dispatcherId || 'dispatcher',
        userName: data.userName, userId: data.userId, extraData: rest,
      });
    }
    socket.emit('dispatcher_end_call_ack', { callId, success: true });
  });

  socket.on('call_ended_by_dispatcher', (data) => {
    const { callId, ...rest } = data || {};
    if (!callId) return;
    broadcastEndCall(callId, {
      dispatcherName: data.dispatcherName || socket.dispatcherName || 'Dispatcher',
      dispatcherId: data.dispatcherId || socket.dispatcherId || 'dispatcher',
      userName: data.userName, userId: data.userId, extraData: rest,
    });
    socket.emit('dispatcher_end_call_ack', { callId, success: true });
  });

  socket.on('dispatcher_end_call', (data) => {
    const { callId, ...rest } = data || {};
    if (!callId) return;
    broadcastEndCall(callId, {
      dispatcherName: data.dispatcherName || socket.dispatcherName || 'Dispatcher',
      dispatcherId: data.dispatcherId || socket.dispatcherId || 'dispatcher',
      userName: data.userName, userId: data.userId, extraData: rest,
    });
    socket.emit('dispatcher_end_call_ack', { callId, success: true });
  });

  // ---------------- End call (caller) ----------------
  socket.on('caller_ended_call', (data) => {
    const { callId, userId, userName, ...rest } = data || {};
    if (!callId) return;
    const call = activeCalls.get(callId);
    broadcastCallerEndedCall(callId, {
      userName: userName || call?.userName || 'caller',
      userId: userId || call?.userId || '',
      callerName: userName || call?.userName || 'caller',
      extraData: rest,
    });
  });

  socket.on('caller_end_call', (data) => {
    const { callId, userId, userName, ...rest } = data || {};
    if (!callId) return;
    const call = activeCalls.get(callId);
    broadcastCallerEndedCall(callId, {
      userName: userName || call?.userName || 'caller',
      userId: userId || call?.userId || '',
      callerName: userName || call?.userName || 'caller',
      extraData: rest,
    });
  });

  socket.on('end_call_by_caller', (data) => {
    const { callId, userId, userName, ...rest } = data || {};
    if (!callId) return;
    const call = activeCalls.get(callId);
    broadcastCallerEndedCall(callId, {
      userName: userName || call?.userName || 'caller',
      userId: userId || call?.userId || '',
      callerName: userName || call?.userName || 'caller',
      extraData: rest,
    });
  });

  socket.on('call_dismissed', (data) => {
    const { callId } = data || {};
    if (!callId) return;
    const call = activeCalls.get(callId);
    const dismissData = {
      callId,
      dispatcherName: data.dispatcherName || socket.dispatcherName || 'Dispatcher',
      dismissedBy: data.dispatcherName || socket.dispatcherName || 'Dispatcher',
      timestamp: new Date().toISOString(),
    };
    io.to(`call_${callId}`).emit('call_dismissed', dismissData);
    io.to(`call_${callId}`).emit('call_ended', dismissData);
    if (call?.callerSocketId) {
      io.to(call.callerSocketId).emit('webrtc_call_ended', {
        callId, endedBy: 'dispatcher', timestamp: new Date().toISOString(),
      });
    }
    webrtcPeers.delete(callId);
    scheduleCallCleanup(callId);
  });

  // ---------------- Disconnect ----------------
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    const callId = socketToCall.get(socket.id);
    if (callId) {
      const call = activeCalls.get(callId);
      if (call) {
        const isCaller = call.callerSocketId === socket.id;
        const otherParty = isCaller ? call.dispatcherSocketId : call.callerSocketId;
        if (otherParty) {
          io.to(otherParty).emit('peer_disconnected', {
            callId,
            reason: isCaller ? 'caller_disconnected' : 'dispatcher_disconnected',
            timestamp: Date.now(),
          });
          io.to(otherParty).emit('webrtc_call_ended', {
            callId, endedBy: isCaller ? 'caller' : 'dispatcher',
            timestamp: new Date().toISOString(),
          });
        }
        call.status = 'disconnected';
        call.endedAt = Date.now();
        activeCalls.set(callId, call);

        if (isCaller) {
          io.to('dispatcher_room').emit('caller_ended_call', {
            callId, userName: call.userName, userId: call.userId,
            endedBy: 'caller', reason: 'caller_disconnected',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
    socketToCall.delete(socket.id);
    socketToUser.delete(socket.id);
  });
});

// ---------------- Cleanup ----------------
setInterval(() => {
  const now = Date.now();
  for (const [callId, call] of activeCalls) {
    if (['ended', 'disconnected', 'dismissed'].includes(call.status)
      && call.endedAt && (now - call.endedAt) > 60000) {
      activeCalls.delete(callId);
      webrtcPeers.delete(callId);
      console.log(`🧹 Cleaned up ${callId}`);
    }
    if (call.status === 'ringing' && (now - call.timestamp) > 120000) {
      activeCalls.delete(callId);
      webrtcPeers.delete(callId);
    }
  }
}, 30000);

// ============================================================
// ✅ SPA FALLBACK — MUST be the LAST route before server.listen
// Sends index.html for any non-API, non-socket.io route so
// React Router / deep links work on refresh.
// Uses regex (/.*/) for Express 5 compatibility.
// ============================================================
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next();
  }

  const indexPath = path.join(DIST_DIR, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('❌ Failed to send index.html:', err.message);
      res.status(503).send(
        'Frontend not built. Run `npm run build` in the project root, then restart the server.'
      );
    }
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server on ${HOST}:${PORT}`);
  console.log(`📊 Health:   http://localhost:${PORT}/api/health`);
  console.log(`🌐 Frontend: http://localhost:${PORT}`);
  console.log(`✅ WebRTC signaling: ENABLED`);

  // Sanity check: warn if dist/ is missing
  const distIndex = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.warn('⚠️  dist/index.html not found — run `npm run build` first!');
  } else {
    console.log(`📦 Serving built frontend from: ${DIST_DIR}`);
  }
});

process.on('SIGINT', () => {
  console.log('🛑 Shutting down...');
  io.close(() => server.close(() => process.exit(0)));
});

module.exports = { app, server, io };