const WebSocket = require('ws');
const os = require('os');
const { exec } = require('child_process');

// Obtener IP local
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const ifname of Object.keys(interfaces)) {
        for (const iface of interfaces[ifname]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '0.0.0.0';
}

const localIP = getLocalIP();
const PORT = process.env.PORT || 8080;

console.log('IP local detectada:', localIP);
console.log(`Servidor WebRTC corriendo en puerto ${PORT}`);
console.log('Para crear túnel, ejecuta en otra terminal:');
console.log(`tunnelmole --port ${PORT}`);

const wss = new WebSocket.Server({ 
    port: PORT,
    clientTracking: true,
    handleProtocols: () => 'websocket',
    perMessageDeflate: {
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        }
    }
});

const rooms = new Map();
const clientRooms = new Map();

// Añadir heartbeat para detectar conexiones muertas
function setupHeartbeat(ws) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
}

// Verificar conexiones activas cada 30 segundos
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      handleDisconnect(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Mejorar el manejo de mensajes
wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substr(2, 9);
  console.log(`Nueva conexión establecida (ID: ${ws.id})`);
  
  ws.isAlive = true;
  setupHeartbeat(ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`Cliente ${ws.id} envió mensaje:`, data);

      switch (data.type) {
        case 'join':
          handleJoinRoom(ws, data.roomId);
          break;
          
        case 'ping':
          ws.isAlive = true;
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
          
        case 'offer':
          handleSignaling(ws, data);
          break;
          
        case 'answer':
          handleSignaling(ws, data);
          break;
          
        case 'ice-candidate':
          handleSignaling(ws, data);
          break;
          
        case 'leave':
          handleLeaveRoom(ws);
          break;
          
        default:
          console.warn(`Tipo de mensaje no manejado: ${data.type}`);
      }
    } catch (error) {
      console.error('Error procesando mensaje:', error);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (error) => {
    console.error('Error en WebSocket:', error);
    handleDisconnect(ws);
  });
});

// Mejorar manejo de salas
function handleJoinRoom(ws, roomId) {
  if (!roomId) {
    console.log('Intento de unirse a sala sin ID');
    return;
  }
  
  console.log(`Procesando solicitud de unión a sala ${roomId} para cliente ${ws.id}`);

  // Verificar si la sala existe y tiene espacio
  const room = rooms.get(roomId);
  if (room && room.size >= 2) {
    console.log(`Sala ${roomId} llena, rechazando conexión`);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'room_full'
    }));
    return;
  }

  // Crear nueva sala si no existe
  if (!rooms.has(roomId)) {
    console.log(`Creando nueva sala: ${roomId}`);
    rooms.set(roomId, new Set());
  }

  // Limpiar conexiones anteriores del mismo cliente
  const existingRoom = rooms.get(roomId);
  existingRoom.forEach(client => {
    if (client.id === ws.id && client !== ws) {
      console.log(`Eliminando conexión duplicada del cliente ${client.id}`);
      handleDisconnect(client);
    }
  });

  // Añadir cliente a la sala
  existingRoom.add(ws);
  ws.roomId = roomId;
  clientRooms.set(ws, roomId);

  // Notificar estado actualizado
  broadcastToRoom(roomId, {
    type: 'room_status',
    roomId,
    peerCount: existingRoom.size
  });
}

function handleLeaveRoom(ws) {
  const roomId = clientRooms.get(ws);
  if (!roomId) return;
  
  const room = rooms.get(roomId);
  if (room) {
    room.delete(ws);
    
    // Si la sala queda vacía, eliminarla
    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`Sala eliminada: ${roomId}`);
    } else {
      // Notificar a los peers restantes
      broadcastToRoom(roomId, {
        type: 'peer-left',
        roomId,
        peerCount: room.size
      });
    }
  }
  
  clientRooms.delete(ws);
  ws.roomId = null;
}

function handleDisconnect(ws) {
  const roomId = ws.roomId;
  if (roomId) {
    const room = rooms.get(roomId);
    if (room) {
      console.log(`Cliente ${ws.id} desconectándose de sala ${roomId}`);
      
      // Eliminar cliente de la sala inmediatamente
      room.delete(ws);
      
      // Notificar a los clientes restantes antes de eliminar la sala
      if (room.size > 0) {
        broadcastToRoom(roomId, {
          type: 'peer-left',
          roomId,
          peerCount: room.size
        });
      }
      
      // Si la sala está vacía, eliminarla
      if (room.size === 0) {
        console.log(`Eliminando sala vacía: ${roomId}`);
        rooms.delete(roomId);
      }
    }
    
    clientRooms.delete(ws);
    ws.roomId = null;
  }

  // Limpiar recursos del cliente
  ws.isAlive = false;
  ws.terminate();
}

function broadcastToRoom(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const messageStr = JSON.stringify(message);
  room.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// Verificar periódicamente conexiones muertas
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      handleDisconnect(ws);
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function handleSignaling(ws, data) {
  const roomId = clientRooms.get(ws);
  if (!roomId) return;
  
  const room = rooms.get(roomId);
  if (!room) return;

  // Solo enviar a otros clientes en la misma sala
  const clientCount = room.size;
  console.log(`Reenviando mensaje ${data.type} a ${clientCount - 1} clientes en sala ${roomId}`);
  
  room.forEach(client => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Modificar el intervalo de ping para ser más eficiente
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      // Solo terminar si no hay actividad por dos intervalos
      if (ws.lastPing === false) {
        console.log(`Terminando conexión inactiva (ID: ${ws.id})`);
        handleDisconnect(ws);
        return ws.terminate();
      }
      ws.lastPing = false;
    } else {
      ws.lastPing = true;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});
