import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GameRoom } from "./GameRoom";

interface WsMessage {
  type: string;
  [key: string]: any;
}

function send(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    const json = JSON.stringify(data);
    console.log(`[Galaga] ⬆ ENVIANDO:`, json);
    ws.send(json);
  } else {
    console.log(`[Galaga] ⚠ WebSocket não está aberto, mensagem descartada`);
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

export function setupGalaga(server: http.Server) {
  const rooms: Map<string, GameRoom> = new Map();
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  console.log(`[Galaga] ✅ Handlers registrados (/v1/galaga/host e /v1/galaga/client)`);

  // ═══════════════════════════════════════
  // HOST — ws://host:port/galaga/host?roomId=xxx
  // ═══════════════════════════════════════
  hostWss.on("connection", (ws, request) => {
    const roomId = getRoomIdFromUrl(request.url);

    console.log(`[Galaga/Host] 🟢 Host conectado`);
    console.log(`[Galaga/Host] 🏠 roomId: "${roomId}"`);

    if (!roomId) {
      console.log(`[Galaga/Host] ❌ roomId não informado!`);
      send(ws, { type: "error", message: "roomId não informado. Use: /galaga/host?roomId=xxx" });
      ws.close();
      return;
    }

    if (rooms.has(roomId)) {
      console.log(`[Galaga/Host] ❌ Sala "${roomId}" já existe!`);
      send(ws, { type: "error", message: "Sala já existe." });
      ws.close();
      return;
    }

    // Auto-create room (hostSocketId not important here)
    const room = new GameRoom(roomId, "galaga", "host");
    room.hostWs = ws;
    rooms.set(roomId, room);

    console.log(`[Galaga/Host] ✅ Sala "${roomId}" criada`);
    console.log(`[Galaga/Host] 📊 Total de salas ativas: ${rooms.size}`);

    ws.on("message", (raw) => {
      const rawStr = raw.toString();
      console.log(`[Galaga/Host] ⬇ RECEBIDO:`, rawStr);

      let msg: WsMessage;
      try {
        msg = JSON.parse(rawStr);
      } catch (e) {
        console.log(`[Galaga/Host] ❌ JSON inválido:`, rawStr);
        return;
      }

      console.log(`[Galaga/Host] 📨 Tipo: "${msg.type}"`);

      // Host is ready and sets maxPlayers
      if (msg.type === "hostReady") {
        if (msg.maxPlayers) {
          room.setMaxPlayers(msg.maxPlayers);
          console.log(`[Galaga/Host] ✅ Host pronto. maxPlayers=${msg.maxPlayers}`);
        }
        send(ws, { type: "room-created", roomId });
      }

      // Host sends data to a specific player by relay ID
      if (msg.type === "sendToPlayer") {
        const playerId = String(msg.playerId);
        console.log(`[Galaga/Host] 📤 Enviando para jogador ${playerId}: "${msg.data}"`);

        const player = room.getPlayer(playerId);
        if (player?.ws) {
          console.log(`[Galaga/Host] ✅ Jogador encontrado (player #${player.playerNumber})`);
          // Send raw data string, exactly as the C# game sends
          player.ws.send(msg.data);
        } else {
          console.log(`[Galaga/Host] ⚠ Jogador ${playerId} NÃO encontrado`);
        }
      }

      // Host broadcasts to all players
      if (msg.type === "sendToAll") {
        console.log(`[Galaga/Host] 📢 Broadcast (${room.playerCount()} jogadores): "${msg.data}"`);
        for (const [, player] of room.players) {
          if (player.ws) {
            // Send raw data string
            player.ws.send(msg.data);
          }
        }
      }

      // Host disconnects a specific player
      if (msg.type === "disconnectPlayer") {
        const playerId = String(msg.playerId);
        console.log(`[Galaga/Host] 🔌 Host solicitou desconexão do jogador ${playerId}`);
        const player = room.getPlayer(playerId);
        if (player?.ws) {
          player.ws.close();
        }
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[Galaga/Host] 🔴 Host desconectado (code: ${code})`);
      console.log(`[Galaga/Host] 🗑 Fechando sala "${roomId}"`);

      for (const [, player] of room.players) {
        if (player.ws) {
          // Send Reset as raw string (like the C# code does with SendForAllClient("Reset"))
          player.ws.send("Reset");
        }
      }
      rooms.delete(roomId);
      console.log(`[Galaga/Host] ✅ Sala removida. Salas ativas: ${rooms.size}`);
    });

    ws.on("error", (err) => {
      console.log(`[Galaga/Host] ❌ ERRO:`, err.message);
    });
  });

  // ═══════════════════════════════════════
  // CLIENT — ws://host:port/galaga/client
  // Auto-joins the first available room
  // ═══════════════════════════════════════
  clientWss.on("connection", (ws, request) => {
    console.log(`[Galaga/Client] 🟢 Client conectado`);
    console.log(`[Galaga/Client] 🔍 Procurando sala disponível...`);

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
      console.log(`[Galaga/Client] ❌ Nenhuma sala disponível`);
      send(ws, { type: "error", message: "Nenhuma sala disponível." });
      ws.close();
      return;
    }

    // Find lowest available ID (0, 1, 2...) not already taken
    let playerId = 0;
    while (room.getPlayer(String(playerId))) {
      playerId++;
    }
    const playerIdStr = String(playerId);

    console.log(`[Galaga/Client] 🎯 playerId atribuído: ${playerId}`);
    console.log(`[Galaga/Client] 📊 Sala "${roomId}": ${room.playerCount()}/${room.maxPlayers}`);

    // Add player with integer ID as string key
    const player = room.addPlayer(playerIdStr);
    if (!player) {
      console.log(`[Galaga/Client] ❌ Falha ao entrar na sala`);
      ws.close();
      return;
    }

    player.ws = ws;

    console.log(`[Galaga/Client] ✅ Jogador ${playerId} entrou na sala "${roomId}" (${room.playerCount()}/${room.maxPlayers})`);

    // Notify host: playerConnected (matching C# HostClient protocol)
    if (room.hostWs) {
      console.log(`[Galaga/Client] 📤 Notificando host: playerConnected`);
      send(room.hostWs, {
        type: "playerConnected",
        playerId: playerId,
      });
    }

    // Client sends messages (raw strings or JSON) to relay to host
    ws.on("message", (raw) => {
      const rawStr = raw.toString();
      console.log(`[Galaga/Client] ⬇ RECEBIDO de jogador ${playerId}:`, rawStr);

      // Relay as playerMessage to host (matching C# HostClient protocol)
      if (room.hostWs) {
        console.log(`[Galaga/Client] 📤 Repassando para host como playerMessage`);
        send(room.hostWs, {
          type: "playerMessage",
          playerId: playerId,
          data: rawStr,
        });
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[Galaga/Client] 🔴 Jogador ${playerId} desconectou (code: ${code})`);

      const removed = room.removePlayer(playerIdStr);
      if (removed) {
        console.log(`[Galaga/Client] 🗑 Jogador removido. Restantes: ${room.playerCount()}`);

        // Notify host: playerDisconnected (matching C# HostClient protocol)
        if (room.hostWs) {
          console.log(`[Galaga/Client] 📤 Notificando host: playerDisconnected`);
          send(room.hostWs, {
            type: "playerDisconnected",
            playerId: playerId,
          });
        }
      }
    });

    ws.on("error", (err) => {
      console.log(`[Galaga/Client] ❌ ERRO jogador ${playerId}:`, err.message);
    });
  });

  // Route upgrade requests by path
  server.on("upgrade", (request, socket, head) => {
    const pathname = (request.url || "").split("?")[0];

    if (pathname === "/v1/galaga/host") {
      console.log(`[Galaga] 🔌 Upgrade: /v1/galaga/host`);
      hostWss.handleUpgrade(request, socket, head, (ws) => {
        hostWss.emit("connection", ws, request);
      });
    } else if (pathname === "/v1/galaga/client") {
      console.log(`[Galaga] 🔌 Upgrade: /v1/galaga/client`);
      clientWss.handleUpgrade(request, socket, head, (ws) => {
        clientWss.emit("connection", ws, request);
      });
    }
  });

  return { hostWss, clientWss };
}
