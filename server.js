const fs = require("fs");
const https = require("https");
const WebSocket = require("ws");
const os = require("os");

// Cargar certificados SSL
const options = {
  key: fs.readFileSync("/etc/letsencrypt/live/socket.trebet-socket.click/privkey.pem"),
  cert: fs.readFileSync("/etc/letsencrypt/live/socket.trebet-socket.click/fullchain.pem"),
};

// Crear servidor HTTPS
const server = https.createServer(options);

// Configurar WebSocket seguro (WSS)
const wss = new WebSocket.Server({ server });

const PORT = 443; // HTTPS usa el puerto 443

// Función para obtener IP local
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === "IPv4" && !alias.internal) {
        return alias.address;
      }
    }
  }
  return "0.0.0.0";
}

const localIP = getLocalIP();

console.log("=================================");
console.log("Servidor WebRTC iniciado en:");
console.log(`wss://${localIP}:${PORT}`);
console.log("=================================");

// Estado global
const rooms = new Map();
const userSessions = new Map();

// Manejo de conexiones WebSocket
wss.on("connection", (ws) => {
  console.log("Nueva conexión entrante");
  ws.id = Math.random().toString(36).substr(2, 9);

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      console.log("Mensaje recibido:", data);

      switch (data.type) {
        case "join":
          handleJoin(ws, data);
          break;
        case "offer":
        case "answer":
        case "ice-candidate":
          broadcastToRoom(data.roomId, JSON.stringify(data), ws);
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case 'camera-status':
            broadcastToRoom(data.roomId, JSON.stringify({
              type: 'camera-status',
              enabled: data.enabled,
              userId: ws.id
            }), ws);
          break;
      }
    } catch (err) {
      console.error("Error procesando mensaje:", err);
    }
  });

  ws.on("close", () => handleDisconnect(ws));
  ws.on("error", console.error);
});

function handleJoin(ws, data) {
  const { roomId } = data;
  let room = rooms.get(roomId);

  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  room.add(ws.id);
  userSessions.set(ws.id, ws);
  ws.roomId = roomId;

  ws.send(JSON.stringify({ type: "room_joined", roomId }));
  broadcastToRoom(roomId, JSON.stringify({ type: "user_joined", userId: ws.id }), ws);
}

function handleDisconnect(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;

  userSessions.delete(ws.id);
  const room = rooms.get(roomId);
  if (room) {
    room.delete(ws.id);
    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcastToRoom(roomId, JSON.stringify({ type: "peer_disconnected", userId: ws.id }));
    }
  }
}

function broadcastToRoom(roomId, message, sender) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.forEach((userId) => {
    const ws = userSessions.get(userId);
    if (ws?.readyState === WebSocket.OPEN && ws !== sender) {
      ws.send(message);
    }
  });
}

// Iniciar el servidor HTTPS con WebSocket seguro
server.listen(PORT, () => {
  console.log(`Servidor corriendo en HTTPS y WSS en el puerto ${PORT}`);
});
