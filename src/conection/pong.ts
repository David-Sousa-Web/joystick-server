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

function getRoomIdFromUrl(url: string | undefined): string | null {
  try {
    const params = new URLSearchParams(url?.split("?")[1] || "");
    return params.get("roomId");
  } catch {
    return null;
  }
}

export function setupPong(server: http.Server) {
  const rooms: Map<string, GameRoom> = new Map();
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  // ═══════════════════════════════════════
  // HOST — ws://host:port/pong/host?roomId=xxx
  // ═══════════════════════════════════════
  hostWss.on("connection", (ws, request) => {
    const socketId = crypto.randomUUID();
    const roomId = getRoomIdFromUrl(request.url);

    console.log(`[Pong/Host] 🟢 Host conectado: ${socketId}, roomId: "${roomId}"`);

    if (!roomId) {
      send(ws, { type: "error", message: "roomId não informado. Use: /pong/host?roomId=xxx" });
      ws.close();
      return;
    }

    if (rooms.has(roomId)) {
      send(ws, { type: "error", message: "Sala já existe." });
      ws.close();
      return;
    }

    // Auto-create room
    const room = new GameRoom(roomId, "pong", socketId);
    room.hostWs = ws;
    rooms.set(roomId, room);

    console.log(`[Pong/Host] ✅ Sala "${roomId}" criada automaticamente`);
    send(ws, { type: "room-created", roomId });

    ws.on("message", (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "send-to-player") {
        const { playerId, dataType, jsonData } = msg;
        const player = room.getPlayer(playerId);
        if (player?.ws) {
          send(player.ws, { type: "game-message", dataType, jsonData });
        }
      }

      if (msg.type === "send-to-all") {
        for (const [, player] of room.players) {
          if (player.ws) {
            send(player.ws, { type: "game-message", dataType: msg.dataType, jsonData: msg.jsonData });
          }
        }
      }
    });

    ws.on("close", () => {
      console.log(`[Pong/Host] 🔴 Host desconectado, fechando sala "${roomId}"`);
      for (const [, player] of room.players) {
        if (player.ws) {
          send(player.ws, { type: "game-message", dataType: "Reset", jsonData: "Host desconectou" });
        }
      }
      rooms.delete(roomId);
    });
  });

  // ═══════════════════════════════════════
  // CLIENT — ws://host:port/pong/client
  // Auto-joins the first available room
  // ═══════════════════════════════════════
  clientWss.on("connection", (ws, request) => {
    const socketId = crypto.randomUUID();

    console.log(`[Pong/Client] 🟢 Client conectado: ${socketId}`);

    // Find first room with space
    let room: GameRoom | null = null;
    let roomId: string | null = null;
    for (const [id, r] of rooms) {
      if (!r.isFull()) {
        room = r;
        roomId = id;
        break;
      }
    }

    if (!room || !roomId) {
      send(ws, { type: "error", message: "Nenhuma sala disponível. Aguarde o host criar uma sala." });
      ws.close();
      return;
    }

    // Auto-join room
    const player = room.addPlayer(socketId);
    if (!player) {
      send(ws, { type: "error", message: "Não foi possível entrar na sala." });
      ws.close();
      return;
    }

    player.ws = ws;

    console.log(`[Pong/Client] ✅ Jogador #${player.playerNumber} entrou na sala "${roomId}" (${room.playerCount()}/${room.maxPlayers})`);

    send(ws, { type: "joined-room", roomId, playerNumber: player.playerNumber });
    send(ws, { type: "game-message", dataType: "ID", jsonData: String(player.playerNumber) });

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

    ws.on("message", (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "send-message") {
        if (!room.hostWs) return;
        send(room.hostWs, {
          type: "receive-message",
          from: socketId,
          playerNumber: player.playerNumber,
          dataType: msg.dataType,
          jsonData: msg.jsonData,
        });
      }

      if (msg.type === "send-input") {
        if (!room.hostWs) return;
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
      console.log(`[Pong/Client] 🔴 Jogador #${player.playerNumber} desconectou da sala "${roomId}"`);
      const removed = room.removePlayer(socketId);
      if (removed && room.hostWs) {
        send(room.hostWs, {
          type: "player-left",
          playerId: socketId,
          playerNumber: removed.playerNumber,
          totalPlayers: room.playerCount(),
          roomId,
        });
      }
    });
  });

  // Route upgrade requests by path
  server.on("upgrade", (request, socket, head) => {
    const pathname = (request.url || "").split("?")[0];

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
