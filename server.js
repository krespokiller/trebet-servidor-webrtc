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
const wss = new WebSocket.Server({ 
  port: PORT,
  perMessageDeflate: false, // Deshabilitar compresión para reducir latencia
  maxPayload: 32768 // Reducir a 32KB para mensajes más pequeños
});

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
        case 'camera-status':
          // Transmitir el estado de la cámara a todos en la sala
          broadcastToRoom(data.roomId, JSON.stringify({
            type: 'camera-status',
            enabled: data.enabled,
            userId: ws.id
          }), ws);
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
  
  // Verificar si existe la sala y está llena
  const existingRoom = rooms.get(roomId);
  if (existingRoom && existingRoom.size >= 2) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room is full'
    }));
    return;
  }
  
  // Verificar si el usuario ya está en la sala
  if (existingRoom?.has(ws.id)) {
    console.log(`Usuario ${ws.id} ya está en la sala ${roomId}`);
    return;
  }
  
  // Limpiar usuario de otras salas
  rooms.forEach((room, rid) => {
    if (room.has(ws.id)) {
      room.delete(ws.id);
      console.log(`Usuario ${ws.id} removido de sala anterior ${rid}`);
    }
  });

  // Crear o unirse a sala
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  room.add(ws.id);
  userSessions.set(ws.id, ws);
  ws.roomId = roomId;

  // Notificar al usuario que se unió (sea el primero o no)
  ws.send(JSON.stringify({
    type: 'room_joined',
    roomId,
    isFirst: room.size === 1,
    networkConfig: {
      isLowBandwidth: true, // Indicar al cliente que use configuración para bajo ancho de banda
      recommendedBitrate: 256000 // 256 kbps como máximo
    }
  }));

  // Si hay más usuarios, notificar a los demás
  if (room.size > 1) {
    console.log(`Notificando user_joined en sala ${roomId}`);
    broadcastToRoom(roomId, JSON.stringify({
      type: 'user_joined',
      userId: ws.id
    }), ws);
  }

  console.log(`Usuario ${ws.id} unido a sala ${roomId}. Usuarios en sala: ${Array.from(room).join(', ')}`);
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

  console.log(`Transmitiendo a sala ${roomId}. Usuarios activos: ${Array.from(room).join(', ')}`);

  room.forEach(userId => {
    const ws = userSessions.get(userId);
    if (ws?.readyState === WebSocket.OPEN && (!sender || ws !== sender)) {
      try {
        ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      } catch (error) {
        console.error(`Error enviando a ${userId}:`, error);
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
}, 10000); // Reducido de 15000 a 10000

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
