import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GameRoom } from "./GameRoom";

interface WsMessage {
  type: string;
  [key: string]: any;
}

function send(ws: WebSocket, data: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function setupPong(server: http.Server) {
  const rooms: Map<string, GameRoom> = new Map();
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  // ═══════════════════════════════════════
  // HOST — ws://host:port/pong/host
  // ═══════════════════════════════════════
  hostWss.on("connection", (ws) => {
    const socketId = crypto.randomUUID();
    console.log(`[Pong/Host] Conectado: ${socketId}`);

    ws.on("message", (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "create-room") {
        const { roomId } = msg;
        if (rooms.has(roomId)) {
          send(ws, { type: "error", message: "Sala já existe." });
          return;
        }

        const room = new GameRoom(roomId, "pong", socketId);
        room.hostWs = ws;
        rooms.set(roomId, room);

        console.log(`[Pong/Host] Sala criada: ${roomId}`);
        send(ws, { type: "room-created", roomId });
      }

      if (msg.type === "send-to-player") {
        const { playerId, dataType, jsonData } = msg;
        // Find the player's ws across all rooms
        for (const [, room] of rooms) {
          const player = room.getPlayer(playerId);
          if (player?.ws) {
            send(player.ws, { type: "game-message", dataType, jsonData });
            return;
          }
        }
      }

      if (msg.type === "send-to-all") {
        const room = rooms.get(msg.roomId);
        if (!room) return;

        for (const [, player] of room.players) {
          if (player.ws) {
            send(player.ws, { type: "game-message", dataType: msg.dataType, jsonData: msg.jsonData });
          }
        }
      }
    });

    ws.on("close", () => {
      console.log(`[Pong/Host] Desconectado: ${socketId}`);

      for (const [roomId, room] of rooms) {
        if (room.hostSocketId === socketId) {
          for (const [, player] of room.players) {
            if (player.ws) {
              send(player.ws, { type: "game-message", dataType: "Reset", jsonData: "Host desconectou" });
            }
          }
          rooms.delete(roomId);
          console.log(`[Pong/Host] Sala ${roomId} fechada`);
          return;
        }
      }
    });
  });

  // ═══════════════════════════════════════
  // CLIENT — ws://host:port/pong/client
  // ═══════════════════════════════════════
  clientWss.on("connection", (ws) => {
    const socketId = crypto.randomUUID();
    let currentRoomId: string | null = null;
    console.log(`[Pong/Client] Conectado: ${socketId}`);

    ws.on("message", (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "join-room") {
        const { roomId } = msg;
        const room = rooms.get(roomId);

        if (!room) {
          send(ws, { type: "error", message: "Sala não encontrada." });
          return;
        }

        if (room.isFull()) {
          send(ws, { type: "game-message", dataType: "ConnectFail", jsonData: "MaxPlayers" });
          return;
        }

        const player = room.addPlayer(socketId);
        if (!player) {
          send(ws, { type: "error", message: "Não foi possível entrar na sala." });
          return;
        }

        player.ws = ws;
        currentRoomId = roomId;

        console.log(`[Pong/Client] Jogador ${player.playerNumber} (${socketId}) entrou na sala ${roomId}`);

        send(ws, { type: "joined-room", roomId, playerNumber: player.playerNumber });
        send(ws, { type: "game-message", dataType: "ID", jsonData: String(player.playerNumber) });

        // Notify host
        if (room.hostWs) {
          send(room.hostWs, {
            type: "player-joined",
            playerId: socketId,
            playerNumber: player.playerNumber,
            totalPlayers: room.playerCount(),
          });

          // Pong requires 2 players
          if (room.isReady()) {
            send(room.hostWs, { type: "game-ready", roomId, players: room.playerCount() });
          }
        }
      }

      if (msg.type === "send-message") {
        const room = currentRoomId ? rooms.get(currentRoomId) : null;
        if (!room) return;

        const player = room.getPlayer(socketId);
        if (!player || !room.hostWs) return;

        send(room.hostWs, {
          type: "receive-message",
          from: socketId,
          playerNumber: player.playerNumber,
          dataType: msg.dataType,
          jsonData: msg.jsonData,
        });
      }

      if (msg.type === "send-input") {
        const room = currentRoomId ? rooms.get(currentRoomId) : null;
        if (!room) return;

        const player = room.getPlayer(socketId);
        if (!player || !room.hostWs) return;

        send(room.hostWs, {
          type: "receive-input",
          from: socketId,
          playerNumber: player.playerNumber,
          x: msg.x,
          y: msg.y,
          buttons: msg.buttons,
        });
      }
    });

    ws.on("close", () => {
      console.log(`[Pong/Client] Desconectado: ${socketId}`);

      if (currentRoomId) {
        const room = rooms.get(currentRoomId);
        if (room) {
          const player = room.removePlayer(socketId);
          if (player && room.hostWs) {
            send(room.hostWs, {
              type: "player-left",
              playerId: socketId,
              playerNumber: player.playerNumber,
              totalPlayers: room.playerCount(),
              roomId: currentRoomId,
            });
          }
        }
      }
    });
  });

  // Route upgrade requests by path
  server.on("upgrade", (request, socket, head) => {
    const pathname = request.url || "";

    if (pathname === "/pong/host") {
      hostWss.handleUpgrade(request, socket, head, (ws) => {
        hostWss.emit("connection", ws, request);
      });
    } else if (pathname === "/pong/client") {
      clientWss.handleUpgrade(request, socket, head, (ws) => {
        clientWss.emit("connection", ws, request);
      });
    }
  });

  return { hostWss, clientWss };
}
