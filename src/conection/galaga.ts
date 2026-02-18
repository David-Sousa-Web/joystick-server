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

export function setupGalaga(server: http.Server) {
  const rooms: Map<string, GameRoom> = new Map();
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  console.log(`[Galaga] ✅ Handlers registrados (/galaga/host e /galaga/client)`);

  // ═══════════════════════════════════════
  // HOST — ws://host:port/galaga/host
  // ═══════════════════════════════════════
  hostWss.on("connection", (ws) => {
    const socketId = crypto.randomUUID();
    console.log(`[Galaga/Host] 🟢 Host conectado: ${socketId}`);
    console.log(`[Galaga/Host] 📊 Total de salas ativas: ${rooms.size}`);

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

      if (msg.type === "create-room") {
        const { roomId } = msg;
        console.log(`[Galaga/Host] 🏠 Tentando criar sala: "${roomId}"`);

        if (rooms.has(roomId)) {
          console.log(`[Galaga/Host] ❌ Sala "${roomId}" já existe!`);
          send(ws, { type: "error", message: "Sala já existe." });
          return;
        }

        const room = new GameRoom(roomId, "galaga", socketId);
        room.hostWs = ws;
        rooms.set(roomId, room);

        console.log(`[Galaga/Host] ✅ Sala "${roomId}" criada com sucesso`);
        console.log(`[Galaga/Host] 📊 Total de salas ativas: ${rooms.size}`);
        send(ws, { type: "room-created", roomId });
      }

      if (msg.type === "send-to-player") {
        const { playerId, dataType, jsonData } = msg;
        console.log(`[Galaga/Host] 📤 Host enviando para jogador ${playerId}: dataType="${dataType}", jsonData="${jsonData}"`);

        let found = false;
        for (const [roomId, room] of rooms) {
          const player = room.getPlayer(playerId);
          if (player?.ws) {
            console.log(`[Galaga/Host] ✅ Jogador ${playerId} encontrado na sala "${roomId}" (player #${player.playerNumber})`);
            send(player.ws, { type: "game-message", dataType, jsonData });
            found = true;
            return;
          }
        }
        if (!found) {
          console.log(`[Galaga/Host] ⚠ Jogador ${playerId} NÃO encontrado em nenhuma sala`);
        }
      }

      if (msg.type === "send-to-all") {
        const room = rooms.get(msg.roomId);
        if (!room) {
          console.log(`[Galaga/Host] ⚠ send-to-all: Sala "${msg.roomId}" não encontrada`);
          return;
        }

        console.log(`[Galaga/Host] 📢 Broadcast para sala "${msg.roomId}" (${room.playerCount()} jogadores): dataType="${msg.dataType}"`);
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

      for (const [roomId, room] of rooms) {
        if (room.hostSocketId === socketId) {
          console.log(`[Galaga/Host] 🗑 Fechando sala "${roomId}" (${room.playerCount()} jogadores serão notificados)`);
          for (const [playerId, player] of room.players) {
            if (player.ws) {
              console.log(`[Galaga/Host]   → Notificando jogador #${player.playerNumber} (${playerId}) sobre Reset`);
              send(player.ws, { type: "game-message", dataType: "Reset", jsonData: "Host desconectou" });
            }
          }
          rooms.delete(roomId);
          console.log(`[Galaga/Host] ✅ Sala "${roomId}" removida. Salas ativas: ${rooms.size}`);
          return;
        }
      }
      console.log(`[Galaga/Host] ℹ Host ${socketId} não era dono de nenhuma sala`);
    });

    ws.on("error", (err) => {
      console.log(`[Galaga/Host] ❌ ERRO no WebSocket do host ${socketId}:`, err.message);
    });
  });

  // ═══════════════════════════════════════
  // CLIENT — ws://host:port/galaga/client
  // ═══════════════════════════════════════
  clientWss.on("connection", (ws) => {
    const socketId = crypto.randomUUID();
    let currentRoomId: string | null = null;
    console.log(`[Galaga/Client] 🟢 Client conectado: ${socketId}`);

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

      if (msg.type === "join-room") {
        const { roomId } = msg;
        console.log(`[Galaga/Client] 🚪 Jogador ${socketId} tentando entrar na sala "${roomId}"`);

        const room = rooms.get(roomId);

        if (!room) {
          console.log(`[Galaga/Client] ❌ Sala "${roomId}" não encontrada`);
          send(ws, { type: "error", message: "Sala não encontrada." });
          return;
        }

        console.log(`[Galaga/Client] 📊 Sala "${roomId}": ${room.playerCount()}/${room.maxPlayers} jogadores`);

        if (room.isFull()) {
          console.log(`[Galaga/Client] ❌ Sala "${roomId}" está cheia!`);
          send(ws, { type: "game-message", dataType: "ConnectFail", jsonData: "MaxPlayers" });
          return;
        }

        const player = room.addPlayer(socketId);
        if (!player) {
          console.log(`[Galaga/Client] ❌ Falha ao adicionar jogador ${socketId} na sala "${roomId}"`);
          send(ws, { type: "error", message: "Não foi possível entrar na sala." });
          return;
        }

        player.ws = ws;
        currentRoomId = roomId;

        console.log(`[Galaga/Client] ✅ Jogador #${player.playerNumber} (${socketId}) entrou na sala "${roomId}"`);
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

          // Galaga is ready with 1 player
          if (room.isReady()) {
            console.log(`[Galaga/Client] 🎮 Sala "${roomId}" está PRONTA! (${room.playerCount()} jogadores, mínimo: ${room.minPlayers})`);
            send(room.hostWs, { type: "game-ready", roomId, players: room.playerCount() });
          } else {
            console.log(`[Galaga/Client] ⏳ Sala "${roomId}" ainda não está pronta (${room.playerCount()}/${room.minPlayers} mínimo)`);
          }
        } else {
          console.log(`[Galaga/Client] ⚠ Host WebSocket não disponível para sala "${roomId}"!`);
        }
      }

      if (msg.type === "send-message") {
        console.log(`[Galaga/Client] 📤 Jogador ${socketId} enviando mensagem: dataType="${msg.dataType}", jsonData="${msg.jsonData}"`);

        const room = currentRoomId ? rooms.get(currentRoomId) : null;
        if (!room) {
          console.log(`[Galaga/Client] ⚠ Jogador ${socketId} não está em nenhuma sala`);
          return;
        }

        const player = room.getPlayer(socketId);
        if (!player || !room.hostWs) {
          console.log(`[Galaga/Client] ⚠ Jogador não encontrado ou host offline`);
          return;
        }

        console.log(`[Galaga/Client] ✅ Repassando mensagem do jogador #${player.playerNumber} para o host`);
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

        // Input logs ficam mais resumidos pra não poluir demais
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
      console.log(`[Galaga/Client] 📍 Sala do jogador: ${currentRoomId || "nenhuma"}`);

      if (currentRoomId) {
        const room = rooms.get(currentRoomId);
        if (room) {
          const player = room.removePlayer(socketId);
          if (player) {
            console.log(`[Galaga/Client] 🗑 Jogador #${player.playerNumber} removido da sala "${currentRoomId}"`);
            console.log(`[Galaga/Client] 📊 Jogadores restantes: ${room.playerCount()}`);

            if (room.hostWs) {
              console.log(`[Galaga/Client] 📤 Notificando host sobre player-left`);
              send(room.hostWs, {
                type: "player-left",
                playerId: socketId,
                playerNumber: player.playerNumber,
                totalPlayers: room.playerCount(),
                roomId: currentRoomId,
              });
            }
          } else {
            console.log(`[Galaga/Client] ⚠ Jogador ${socketId} não foi encontrado na sala "${currentRoomId}"`);
          }
        } else {
          console.log(`[Galaga/Client] ⚠ Sala "${currentRoomId}" já não existe mais`);
        }
      }
    });

    ws.on("error", (err) => {
      console.log(`[Galaga/Client] ❌ ERRO no WebSocket do client ${socketId}:`, err.message);
    });
  });

  // Route upgrade requests by path
  server.on("upgrade", (request, socket, head) => {
    const pathname = request.url || "";

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
