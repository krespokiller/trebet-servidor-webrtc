const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

const rooms = new Map();

wss.on('connection', (ws) => {
  console.log('Nueva conexión establecida');
  
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log('Mensaje recibido:', data.type, 'para sala:', data.roomId);

    switch (data.type) {
      case 'join':
        handleJoinRoom(ws, data.roomId);
        break;
      
      case 'offer':
        console.log('Reenviando oferta a sala:', data.roomId);
        handleSignaling(ws, data);
        break;
      
      case 'answer':
        console.log('Reenviando respuesta a sala:', data.roomId);
        handleSignaling(ws, data);
        break;
      
      case 'ice-candidate':
        console.log('Reenviando candidato ICE');
        handleSignaling(ws, data);
        break;
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

function handleJoinRoom(ws, roomId) {
  if (!roomId) {
    console.log('No se proporcionó roomId');
    return;
  }
  
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  
  const room = rooms.get(roomId);
  room.add(ws);
  ws.roomId = roomId;
  
  console.log(`Cliente unido a sala: ${roomId}. Total en sala: ${room.size}`);
}

function handleSignaling(ws, data) {
  if (!ws.roomId) {
    console.log('Cliente no está en ninguna sala');
    return;
  }
  
  const room = rooms.get(ws.roomId);
  if (!room) {
    console.log('Sala no encontrada:', ws.roomId);
    return;
  }

  console.log(`Reenviando mensaje ${data.type} a ${room.size - 1} clientes en sala ${ws.roomId}`);
  
  room.forEach(client => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      console.log('Enviando a cliente en sala');
      client.send(JSON.stringify(data));
    }
  });
}

function handleDisconnect(ws) {
  if (!ws.roomId) return;
  
  const room = rooms.get(ws.roomId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(ws.roomId);
      console.log(`Sala eliminada: ${ws.roomId}`);
    }
  }
}

console.log('Servidor WebRTC corriendo en ws://localhost:8080');
