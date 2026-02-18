import { Server, Namespace } from "socket.io";
import { GameRoom } from "./GameRoom";

export function setupPong(io: Server) {
  const rooms: Map<string, GameRoom> = new Map();
  const hostNsp = io.of("/pong/host");
  const clientNsp = io.of("/pong/client");

  // ═══════════════════════════════════════
  // HOST namespace — /pong/host
  // ═══════════════════════════════════════
  hostNsp.on("connection", (socket) => {
    console.log(`[Pong/Host] Conectado: ${socket.id}`);

    socket.on("create-room", (data: { roomId: string }) => {
      const { roomId } = data;

      if (rooms.has(roomId)) {
        socket.emit("error", "Sala já existe.");
        return;
      }

      const room = new GameRoom(roomId, "pong", socket.id);
      rooms.set(roomId, room);

      console.log(`[Pong/Host] Sala criada: ${roomId}`);
      socket.emit("room-created", { roomId });
    });

    // Host sends message to a specific player
    socket.on("send-to-player", (data: { playerId: string; dataType: string; jsonData?: string }) => {
      clientNsp.to(data.playerId).emit("game-message", {
        dataType: data.dataType,
        jsonData: data.jsonData,
      });
    });

    // Host broadcasts to all players in the room
    socket.on("send-to-all", (data: { roomId: string; dataType: string; jsonData?: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      for (const [playerId] of room.players) {
        clientNsp.to(playerId).emit("game-message", {
          dataType: data.dataType,
          jsonData: data.jsonData,
        });
      }
    });

    socket.on("disconnect", (reason) => {
      console.log(`[Pong/Host] Desconectado: ${socket.id} (${reason})`);

      for (const [roomId, room] of rooms) {
        if (room.hostSocketId === socket.id) {
          // Notify all clients that the room is closed
          for (const [playerId] of room.players) {
            clientNsp.to(playerId).emit("game-message", {
              dataType: "Reset",
              jsonData: "Host desconectou",
            });
          }
          rooms.delete(roomId);
          console.log(`[Pong/Host] Sala ${roomId} fechada`);
          return;
        }
      }
    });
  });

  // ═══════════════════════════════════════
  // CLIENT namespace — /pong/client
  // ═══════════════════════════════════════
  clientNsp.on("connection", (socket) => {
    console.log(`[Pong/Client] Conectado: ${socket.id}`);

    socket.on("join-room", (data: { roomId: string }) => {
      const { roomId } = data;
      const room = rooms.get(roomId);

      if (!room) {
        socket.emit("error", "Sala não encontrada.");
        return;
      }

      if (room.isFull()) {
        socket.emit("game-message", {
          dataType: "ConnectFail",
          jsonData: "MaxPlayers",
        });
        return;
      }

      const player = room.addPlayer(socket.id);
      if (!player) {
        socket.emit("error", "Não foi possível entrar na sala.");
        return;
      }

      socket.data.roomId = roomId;

      console.log(`[Pong/Client] Jogador ${player.playerNumber} (${socket.id}) entrou na sala ${roomId}`);

      // Confirm to the player
      socket.emit("joined-room", {
        roomId,
        playerNumber: player.playerNumber,
      });

      socket.emit("game-message", {
        dataType: "ID",
        jsonData: String(player.playerNumber),
      });

      // Notify host
      hostNsp.to(room.hostSocketId).emit("player-joined", {
        playerId: socket.id,
        playerNumber: player.playerNumber,
        totalPlayers: room.playerCount(),
      });

      // Pong requires 2 players
      if (room.isReady()) {
        hostNsp.to(room.hostSocketId).emit("game-ready", {
          roomId,
          players: room.playerCount(),
        });
      }
    });

    // Client sends game message to host
    socket.on("send-message", (data: { roomId: string; dataType: string; jsonData?: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      const player = room.getPlayer(socket.id);
      if (!player) return;

      hostNsp.to(room.hostSocketId).emit("receive-message", {
        from: socket.id,
        playerNumber: player.playerNumber,
        dataType: data.dataType,
        jsonData: data.jsonData,
      });
    });

    // Client sends coordinates/input to host
    socket.on("send-input", (data: { roomId: string; x: number; y: number; buttons?: Record<string, boolean> }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      const player = room.getPlayer(socket.id);
      if (!player) return;

      hostNsp.to(room.hostSocketId).emit("receive-input", {
        from: socket.id,
        playerNumber: player.playerNumber,
        x: data.x,
        y: data.y,
        buttons: data.buttons,
      });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[Pong/Client] Desconectado: ${socket.id} (${reason})`);

      for (const [roomId, room] of rooms) {
        const player = room.removePlayer(socket.id);
        if (player) {
          console.log(`[Pong/Client] Jogador ${player.playerNumber} saiu da sala ${roomId}`);

          hostNsp.to(room.hostSocketId).emit("player-left", {
            playerId: socket.id,
            playerNumber: player.playerNumber,
            totalPlayers: room.playerCount(),
            roomId,
          });
          return;
        }
      }
    });
  });
}
