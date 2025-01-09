const WebSocket = require('ws');
const os = require('os');

// Función para obtener IP local
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '0.0.0.0';
}

const localIP = getLocalIP();
const PORT = process.env.PORT || 8080;

console.log('=================================');
console.log('Servidor WebRTC iniciado en:');
console.log(`ws://${localIP}:${PORT}`);
console.log('=================================');

// Configuración del servidor
const wss = new WebSocket.Server({ port: PORT });

// Estado global
const rooms = new Map();
const userSessions = new Map();
const userReconnectTimers = new Map();

// Configuración de reconexión
const RECONNECT_TIMEOUT = 30000; // 30 segundos para limpiar usuario si no reconecta

wss.on('connection', (ws) => {
  console.log('Nueva conexión entrante');
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Mensaje recibido:', data);
      
      switch(data.type) {
        case 'join':
          handleJoin(ws, data);
          break;
        case 'signal':
          handleSignal(ws, data);
          break;
        case 'ping':
          ws.send(JSON.stringify({type: 'pong'}));
          break;
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', console.error);
});

function handleJoin(ws, data) {
  const { roomId, userId } = data;
  
  // Limpiar timer de reconexión si existe
  clearReconnectTimer(userId);
  
  // Manejar sesión existente
  const existingWs = userSessions.get(userId);
  if (existingWs && existingWs !== ws) {
    console.log(`Usuario ${userId} reconectando, limpiando sesión anterior`);
    existingWs.close();
    userSessions.delete(userId);
  }

  // Registrar nueva sesión
  ws.userId = userId;
  ws.roomId = roomId;
  userSessions.set(userId, ws);

  // Manejar sala
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  room.add(userId);
  console.log(`Usuario ${userId} unido a sala ${roomId}`);

  // Notificar estado de sala
  broadcastToRoom(roomId, {
    type: 'room_status',
    users: Array.from(room),
    joined: userId
  });
}

function handleSignal(ws, data) {
  const { target, signal } = data;
  const targetWs = userSessions.get(target);
  
  if (targetWs?.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      type: 'signal',
      from: ws.userId,
      signal
    }));
  }
}

function handleDisconnect(ws) {
  const { userId, roomId } = ws;
  if (!userId || !roomId) return;

  console.log(`Usuario ${userId} desconectado de sala ${roomId}`);

  // Iniciar timer de reconexión
  setReconnectTimer(userId, roomId);

  // No eliminar inmediatamente de la sala, esperar el timeout
  broadcastToRoom(roomId, {
    type: 'peer_disconnected',
    userId,
    temporary: true
  });
}

function setReconnectTimer(userId, roomId) {
  const timer = setTimeout(() => {
    console.log(`Timeout de reconexión para usuario ${userId}`);
    finalizeDisconnect(userId, roomId);
  }, RECONNECT_TIMEOUT);

  userReconnectTimers.set(userId, timer);
}

function clearReconnectTimer(userId) {
  const timer = userReconnectTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    userReconnectTimers.delete(userId);
  }
}

function finalizeDisconnect(userId, roomId) {
  userSessions.delete(userId);
  const room = rooms.get(roomId);
  
  if (room) {
    room.delete(userId);
    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`Sala ${roomId} eliminada`);
    } else {
      broadcastToRoom(roomId, {
        type: 'peer_disconnected',
        userId,
        temporary: false
      });
    }
  }
}

function broadcastToRoom(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;

  const messageStr = JSON.stringify(message);
  room.forEach(userId => {
    const ws = userSessions.get(userId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  });
}

// Mantenimiento de conexiones
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      handleDisconnect(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// Log de inicio
console.log(`Servidor WebRTC corriendo en puerto ${PORT}`);
