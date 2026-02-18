import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GameRoom } from "./GameRoom";

interface WsMessage {
  type: string;
  [key: string]: any;
}

function send(ws: WebSocket, data: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    console.log(`[Galaga] ⬆ ENVIANDO:`, JSON.stringify(data));
    ws.send(JSON.stringify(data));
  } else {
    console.log(`[Galaga] ⚠ WebSocket não está aberto, mensagem descartada:`, JSON.stringify(data));
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

  console.log(`[Galaga] ✅ Handlers registrados (/galaga/host e /galaga/client)`);

  // ═══════════════════════════════════════
  // HOST — ws://host:port/galaga/host?roomId=xxx
  // Room is auto-created on connection
  // ═══════════════════════════════════════
  hostWss.on("connection", (ws, request) => {
    const socketId = crypto.randomUUID();
    const roomId = getRoomIdFromUrl(request.url);

    console.log(`[Galaga/Host] 🟢 Host conectado: ${socketId}`);
    console.log(`[Galaga/Host] 🏠 roomId da URL: "${roomId}"`);

    if (!roomId) {
      console.log(`[Galaga/Host] ❌ roomId não informado na URL! Use: /galaga/host?roomId=xxx`);
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

    // Auto-create room
    const room = new GameRoom(roomId, "galaga", socketId);
    room.hostWs = ws;
    rooms.set(roomId, room);

    console.log(`[Galaga/Host] ✅ Sala "${roomId}" criada automaticamente`);
    console.log(`[Galaga/Host] 📊 Total de salas ativas: ${rooms.size}`);
    send(ws, { type: "room-created", roomId });

    ws.on("message", (raw) => {
      const rawStr = raw.toString();
      console.log(`[Galaga/Host] ⬇ RECEBIDO de ${socketId}:`, rawStr);

      let msg: WsMessage;
      try {
        msg = JSON.parse(rawStr);
      } catch (e) {
        console.log(`[Galaga/Host] ❌ JSON inválido de ${socketId}:`, rawStr);
        return;
      }

      console.log(`[Galaga/Host] 📨 Tipo: "${msg.type}"`);

      if (msg.type === "send-to-player") {
        const { playerId, dataType, jsonData } = msg;
        console.log(`[Galaga/Host] 📤 Host enviando para jogador ${playerId}: dataType="${dataType}", jsonData="${jsonData}"`);

        const player = room.getPlayer(playerId);
        if (player?.ws) {
          console.log(`[Galaga/Host] ✅ Jogador encontrado (player #${player.playerNumber})`);
          send(player.ws, { type: "game-message", dataType, jsonData });
        } else {
          console.log(`[Galaga/Host] ⚠ Jogador ${playerId} NÃO encontrado na sala`);
        }
      }

      if (msg.type === "send-to-all") {
        console.log(`[Galaga/Host] 📢 Broadcast para sala "${roomId}" (${room.playerCount()} jogadores): dataType="${msg.dataType}"`);
        for (const [playerId, player] of room.players) {
          if (player.ws) {
            console.log(`[Galaga/Host]   → Enviando para jogador #${player.playerNumber} (${playerId})`);
            send(player.ws, { type: "game-message", dataType: msg.dataType, jsonData: msg.jsonData });
          }
        }
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[Galaga/Host] 🔴 Host desconectado: ${socketId} (code: ${code}, reason: ${reason.toString() || "N/A"})`);
      console.log(`[Galaga/Host] 🗑 Fechando sala "${roomId}" (${room.playerCount()} jogadores serão notificados)`);

      for (const [playerId, player] of room.players) {
        if (player.ws) {
          console.log(`[Galaga/Host]   → Notificando jogador #${player.playerNumber} (${playerId}) sobre Reset`);
          send(player.ws, { type: "game-message", dataType: "Reset", jsonData: "Host desconectou" });
        }
      }
      rooms.delete(roomId);
      console.log(`[Galaga/Host] ✅ Sala "${roomId}" removida. Salas ativas: ${rooms.size}`);
    });

    ws.on("error", (err) => {
      console.log(`[Galaga/Host] ❌ ERRO no WebSocket do host ${socketId}:`, err.message);
    });
  });

  // ═══════════════════════════════════════
  // CLIENT — ws://host:port/galaga/client
  // Auto-joins the first available room
  // ═══════════════════════════════════════
  clientWss.on("connection", (ws, request) => {
    const socketId = crypto.randomUUID();

    console.log(`[Galaga/Client] 🟢 Client conectado: ${socketId}`);
    console.log(`[Galaga/Client] � Procurando sala disponível... (${rooms.size} salas ativas)`);

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
      send(ws, { type: "error", message: "Nenhuma sala disponível. Aguarde o host criar uma sala." });
      ws.close();
      return;
    }

    console.log(`[Galaga/Client] ✅ Sala encontrada: "${roomId}" (${room.playerCount()}/${room.maxPlayers})`);

    // Auto-join the found room
    const player = room.addPlayer(socketId);
    if (!player) {
      console.log(`[Galaga/Client] ❌ Falha ao adicionar jogador na sala "${roomId}"`);
      send(ws, { type: "error", message: "Não foi possível entrar na sala." });
      ws.close();
      return;
    }

    player.ws = ws;

    console.log(`[Galaga/Client] ✅ Jogador #${player.playerNumber} (${socketId}) entrou automaticamente na sala "${roomId}"`);
    console.log(`[Galaga/Client] 📊 Sala "${roomId}": ${room.playerCount()}/${room.maxPlayers} jogadores`);

    send(ws, { type: "joined-room", roomId, playerNumber: player.playerNumber });
    send(ws, { type: "game-message", dataType: "ID", jsonData: String(player.playerNumber) });

    // Notify host
    if (room.hostWs) {
      console.log(`[Galaga/Client] 📤 Notificando host sobre player-joined`);
      send(room.hostWs, {
        type: "player-joined",
        playerId: socketId,
        playerNumber: player.playerNumber,
        totalPlayers: room.playerCount(),
      });

      if (room.isReady()) {
        console.log(`[Galaga/Client] 🎮 Sala "${roomId}" está PRONTA! (${room.playerCount()} jogadores, mínimo: ${room.minPlayers})`);
        send(room.hostWs, { type: "game-ready", roomId, players: room.playerCount() });
      }
    }

    ws.on("message", (raw) => {
      const rawStr = raw.toString();
      console.log(`[Galaga/Client] ⬇ RECEBIDO de ${socketId}:`, rawStr);

      let msg: WsMessage;
      try {
        msg = JSON.parse(rawStr);
      } catch (e) {
        console.log(`[Galaga/Client] ❌ JSON inválido de ${socketId}:`, rawStr);
        return;
      }

      console.log(`[Galaga/Client] 📨 Tipo: "${msg.type}"`);

      if (msg.type === "send-message") {
        console.log(`[Galaga/Client] 📤 Jogador #${player.playerNumber} enviando: dataType="${msg.dataType}", jsonData="${msg.jsonData}"`);

        if (!room.hostWs) {
          console.log(`[Galaga/Client] ⚠ Host offline`);
          return;
        }

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

        console.log(`[Galaga/Client] 🕹 Input jogador #${player.playerNumber}: x=${msg.x}, y=${msg.y}`);
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

    ws.on("close", (code, reason) => {
      console.log(`[Galaga/Client] 🔴 Client desconectado: ${socketId} (code: ${code}, reason: ${reason.toString() || "N/A"})`);

      const removed = room.removePlayer(socketId);
      if (removed) {
        console.log(`[Galaga/Client] 🗑 Jogador #${removed.playerNumber} removido da sala "${roomId}"`);
        console.log(`[Galaga/Client] 📊 Jogadores restantes: ${room.playerCount()}`);

        if (room.hostWs) {
          console.log(`[Galaga/Client] 📤 Notificando host sobre player-left`);
          send(room.hostWs, {
            type: "player-left",
            playerId: socketId,
            playerNumber: removed.playerNumber,
            totalPlayers: room.playerCount(),
            roomId,
          });
        }
      }
    });

    ws.on("error", (err) => {
      console.log(`[Galaga/Client] ❌ ERRO no WebSocket do client ${socketId}:`, err.message);
    });
  });

  // Route upgrade requests by path
  server.on("upgrade", (request, socket, head) => {
    const pathname = (request.url || "").split("?")[0];

    if (pathname === "/galaga/host") {
      console.log(`[Galaga] 🔌 Upgrade request para /galaga/host`);
      hostWss.handleUpgrade(request, socket, head, (ws) => {
        hostWss.emit("connection", ws, request);
      });
    } else if (pathname === "/galaga/client") {
      console.log(`[Galaga] 🔌 Upgrade request para /galaga/client`);
      clientWss.handleUpgrade(request, socket, head, (ws) => {
        clientWss.emit("connection", ws, request);
      });
    }
  });

  return { hostWss, clientWss };
}
