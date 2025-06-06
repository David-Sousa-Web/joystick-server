import { Server } from "socket.io";

export function setupSocket(io: Server) {
  io.on("connection", (socket) => {
    console.log(`Cliente conectado: ${socket.id}`);

    socket.on("join-play", (roomId: string) => {
      socket.join(roomId);
      console.log(`${socket.id} entrou na sala ${roomId}`);
      socket.emit("joined", { room: roomId });
    });

    //aqui entra os handlers dos controllers

    socket.on("disconnect", (reason) => {
      console.log(`Cliente ${socket.id} desconectado: ${reason}`);
    });
  });
}
