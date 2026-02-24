import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GameRoom } from "./GameRoom";

interface WsMessage {
  type: string;
  [key: string]: any;
}

function sendJson(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendRaw(ws: WebSocket, data: string) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
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

  console.log(`[Pong] ✅ Handlers registrados (/v1/pong/host e /v1/pong/client)`);

  // ═══════════════════════════════════════
  // HOST — ws://host:port/v1/pong/host?roomId=xxx
  // ═══════════════════════════════════════
  hostWss.on("connection", (ws, request) => {
    const roomId = getRoomIdFromUrl(request.url);
    const socketId = crypto.randomUUID();

    console.log(`[Pong/Host] 🟢 Host conectado. roomId: "${roomId}"`);

    if (!roomId) {
      console.log(`[Pong/Host] ❌ roomId não informado! Use: /v1/pong/host?roomId=xxx`);
      sendJson(ws, { type: "error", message: "roomId não informado. Use: /v1/pong/host?roomId=xxx" });
      ws.close();
      return;
    }

    if (rooms.has(roomId)) {
      console.log(`[Pong/Host] ❌ Sala "${roomId}" já existe!`);
      sendJson(ws, { type: "error", message: "Sala já existe." });
      ws.close();
      return;
    }

    // Auto-create room
    const room = new GameRoom(roomId, "pong", socketId);
    room.hostWs = ws;
    rooms.set(roomId, room);

    console.log(`[Pong/Host] ✅ Sala "${roomId}" criada`);
    console.log(`[Pong/Host] 📊 Total de salas ativas: ${rooms.size}`);

    ws.on("message", (raw) => {
      const rawStr = raw.toString();

      let msg: WsMessage;
      try {
        msg = JSON.parse(rawStr);
      } catch (e) {
        return;
      }

      // Host is ready and sets maxPlayers
      if (msg.type === "hostReady") {
        if (msg.maxPlayers) {
          room.setMaxPlayers(msg.maxPlayers);
          console.log(`[Pong/Host] ✅ Host pronto. maxPlayers=${msg.maxPlayers}`);
        }
        sendJson(ws, { type: "room-created", roomId });
      }

      // Host sends data to a specific player (can be playerConnected or sendToPlayer)
      if (msg.type === "sendToPlayer" || msg.type === "playerConnected") {
        const playerId = String(msg.playerId);
        console.log(`[Pong/Host] 📤 Enviando para jogador ${playerId}: "${msg.data}"`);

        const player = room.getPlayer(playerId);
        // The Host relies on the server to send the raw string to the player.
        // e.g., "Partida ja em andamento" or other instructions.
        if (player?.ws) {
          sendRaw(player.ws, msg.data || "");
        } else {
          console.log(`[Pong/Host] ⚠ Jogador ${playerId} NÃO encontrado na sala`);
        }
      }

      // Host broadcasts to all players
      if (msg.type === "sendToAll") {
        for (const [, player] of room.players) {
          if (player.ws) {
            sendRaw(player.ws, msg.data || "");
          }
        }
      }

      // Host disconnects a specific player
      if (msg.type === "disconnectPlayer") {
        const playerId = String(msg.playerId);
        console.log(`[Pong/Host] 🔌 Host solicitou desconexão do jogador ${playerId}`);
        const player = room.getPlayer(playerId);
        if (player?.ws) {
          player.ws.close();
        }
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[Pong/Host] 🔴 Host desconectado (code: ${code})`);
      console.log(`[Pong/Host] 🗑 Fechando sala "${roomId}"`);

      for (const [, player] of room.players) {
        if (player.ws) {
          // Send Reset to clients if host drops, actually, we'll just close their socket
          // to trigger the connection reload logic in the JS client.
          player.ws.close();
        }
      }
      rooms.delete(roomId);
      console.log(`[Pong/Host] ✅ Sala removida. Salas ativas: ${rooms.size}`);
    });

    ws.on("error", (err) => {
      console.log(`[Pong/Host] ❌ ERRO:`, err.message);
    });
  });

  // ═══════════════════════════════════════
  // CLIENT — ws://host:port/v1/pong/client
  // ═══════════════════════════════════════
  clientWss.on("connection", (ws, request) => {
    console.log(`[Pong/Client] 🟢 Client conectado`);
    console.log(`[Pong/Client] 🔍 Procurando sala disponível...`);

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
      console.log(`[Pong/Client] ❌ Nenhuma sala disponível`);
      sendRaw(ws, "Nenhuma sala disponivel");
      ws.close();
      return;
    }

    // Find lowest available ID (0, 1, 2...)
    let playerId = 0;
    while (room.getPlayer(String(playerId))) {
      playerId++;
    }
    const playerIdStr = String(playerId);

    const player = room.addPlayer(playerIdStr);
    if (!player) {
      console.log(`[Pong/Client] ❌ Falha ao entrar na sala`);
      ws.close();
      return;
    }

    player.ws = ws;

    console.log(`[Pong/Client] ✅ Jogador ${playerId} entrou na sala "${roomId}" (${room.playerCount()}/${room.maxPlayers})`);

    // The JS client expects the raw ID (0 or 1) as a string
    sendRaw(ws, String(playerId));

    // Notify host via JSON (matching C# protocol)
    if (room.hostWs) {
      console.log(`[Pong/Client] 📤 Notificando host: playerConnected`);
      sendJson(room.hostWs, {
        type: "playerConnected",
        playerId: playerId,
      });
    }

    ws.on("message", (data, isBinary) => {
      // 1) Binary High-Performance Routing
      if (isBinary && room && room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        const payload = data as Buffer;
        // Host expects 6 bytes: [playerId_u16_le][type][seq][moveX][flags]
        const hostPacket = Buffer.allocUnsafe(2 + payload.length);
        hostPacket.writeUInt16LE(playerId, 0); // Prepend integer playerId
        payload.copy(hostPacket, 2);           // Copy the 4-byte payload from client

        room.hostWs.send(hostPacket);
        return;
      }

      // 2) String/JSON fallback for legacy events
      const rawStr = data.toString();
      if (room && room.hostWs) {
        sendJson(room.hostWs, {
          type: "playerMessage",
          playerId: playerId,
          data: rawStr,
        });
      }
    });

    ws.on("close", (code) => {
      console.log(`[Pong/Client] 🔴 Jogador ${playerId} desconectou (code: ${code})`);

      if (room) {
        const removed = room.removePlayer(playerIdStr);
        if (removed) {
          console.log(`[Pong/Client] 🗑 Jogador removido. Restantes: ${room.playerCount()}`);
          if (room.hostWs) {
            console.log(`[Pong/Client] 📤 Notificando host: playerDisconnected`);
            sendJson(room.hostWs, {
              type: "playerDisconnected",
              playerId: playerId,
            });
          }
        }
      }
    });

    ws.on("error", (err) => {
      console.log(`[Pong/Client] ❌ ERRO jogador ${playerId}:`, err.message);
    });
  });

  // Route upgrade requests by path
  server.on("upgrade", (request, socket, head) => {
    (socket as import("net").Socket).setNoDelay(true); // Disable Nagle's algorithm for low latency

    const pathname = (request.url || "").split("?")[0];

    if (pathname === "/v1/pong/host") {
      hostWss.handleUpgrade(request, socket, head, (ws) => {
        hostWss.emit("connection", ws, request);
      });
    } else if (pathname === "/v1/pong/client") {
      clientWss.handleUpgrade(request, socket, head, (ws) => {
        clientWss.emit("connection", ws, request);
      });
    }
  });

  return { hostWss, clientWss };
}
