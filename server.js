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
  ws.id = Math.random().toString(36).substr(2, 9); // Añadir ID único
  
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
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          broadcastToRoom(data.roomId, JSON.stringify(data), ws);
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
  const { roomId } = data;
  
  // Si el usuario ya estaba en una sala, limpiarlo primero
  if (ws.roomId) {
    const oldRoom = rooms.get(ws.roomId);
    if (oldRoom) {
      oldRoom.delete(ws.id);
      if (oldRoom.size === 0) {
        rooms.delete(ws.roomId);
      }
    }
  }
  
  ws.roomId = roomId;
  let room = rooms.get(roomId);
  
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  } else {
    // Limpiar conexiones muertas antes de añadir el nuevo usuario
    for (const userId of room) {
      const existingWs = userSessions.get(userId);
      if (!existingWs || existingWs.readyState !== WebSocket.OPEN) {
        room.delete(userId);
        userSessions.delete(userId);
      }
    }
  }

  room.add(ws.id);
  userSessions.set(ws.id, ws);

  // Si ya hay alguien en la sala, notificar después de la limpieza
  if (room.size > 1) {  // Cambiado de > 0 a > 1
    broadcastToRoom(roomId, JSON.stringify({
      type: 'user_joined',
      userId: ws.id
    }));
  }

  console.log(`Usuario ${ws.id} unido a sala ${roomId}. Total usuarios activos: ${room.size}`);
}

function handleSignal(ws, data) {
  const { target, signal } = data;
  const targetWs = userSessions.get(target);
  
  if (targetWs?.readyState === WebSocket.OPEN) {
    // Añadir logs para depuración
    console.log('Señalización enviada:', {
      from: ws.userId,
      to: target,
      type: signal.type
    });
    
    targetWs.send(JSON.stringify({
      type: 'signal',
      from: ws.userId,
      signal
    }));
  } else {
    console.log('Usuario objetivo no encontrado o desconectado:', target);
  }
}

function handleDisconnect(ws) {
  const roomId = ws.roomId;
  const userId = ws.id;
  
  if (!roomId || !userId) return;

  console.log(`Usuario ${userId} desconectado de sala ${roomId}`);
  
  // Limpiar inmediatamente el usuario de las estructuras de datos
  userSessions.delete(userId);
  
  const room = rooms.get(roomId);
  if (room) {
    room.delete(userId);
    console.log(`Usuarios restantes en sala ${roomId}: ${room.size}`);
    
    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`Sala ${roomId} eliminada por quedar vacía`);
    } else {
      // Notificar a los demás usuarios de la sala
      broadcastToRoom(roomId, JSON.stringify({
        type: 'peer_disconnected',
        userId
      }));
    }
  }
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

function broadcastToRoom(roomId, message, sender) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Contar usuarios activos primero
  const activeUsers = new Set();
  room.forEach(userId => {
    const ws = userSessions.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      activeUsers.add(userId);
    } else {
      room.delete(userId);
      userSessions.delete(userId);
    }
  });

  console.log(`Transmitiendo mensaje a sala ${roomId} (${activeUsers.size} usuarios válidos)`);

  if (activeUsers.size === 0) {
    console.log(`Eliminando sala vacía: ${roomId}`);
    rooms.delete(roomId);
    return;
  }

  // Transmitir solo a usuarios activos
  activeUsers.forEach(userId => {
    const ws = userSessions.get(userId);
    if (ws && (!sender || ws !== sender)) {
      try {
        ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      } catch (error) {
        console.error(`Error enviando mensaje a usuario ${userId}:`, error);
        handleDisconnect(ws);
      }
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

// Agregar limpieza periódica de conexiones muertas
setInterval(() => {
  console.log('Ejecutando limpieza de conexiones...');
  
  userSessions.forEach((ws, userId) => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`Limpiando usuario inactivo: ${userId}`);
      handleDisconnect(ws);
    }
  });

  rooms.forEach((room, roomId) => {
    if (room.size === 0) {
      console.log(`Limpiando sala vacía: ${roomId}`);
      rooms.delete(roomId);
    }
  });
}, 10000); // Cada 10 segundos

// Log de inicio
console.log(`Servidor WebRTC corriendo en puerto ${PORT}`);
