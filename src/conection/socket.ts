import { Server } from "socket.io";

export function setupSocket(io: Server) {
  const totems: Record<string, string> = {};

  io.on("connection", (socket) => {
    socket.on('join-room-totem', (data: {roomId: string, totemId: string}) => {
      socket.join(data.roomId);
      console.log('Totem entrou:', data);
      totems[data.roomId] = data.totemId;
      socket.data.totemId = data.totemId;

      console.log('Totems:', totems);
      console.log(`${data.totemId} entrou na sala ${data.roomId}`);
      socket.emit('joined-room', { roomId: data.roomId, isTotem: true });
    });

    socket.on('join-room', (roomId: string) => {
      if (totems[roomId]) {
        socket.join(roomId);

        console.log(socket.id, 'entrou na sala', roomId, 'que tem o totem', totems[roomId])
        socket.emit('joined-room', { roomId, isTotem: false });
      } else {
        console.log('error', 'Totem não está presente na sala.')
        socket.emit('error', 'Totem não está presente na sala.');
      }
    });

    socket.on('send-coordinates', (data: { roomId: string, x: number, y: number }) => {
      const totemSocketId = totems[data.roomId];
      if (totemSocketId) {
        io.to(totemSocketId).emit('receive-coordinates', {
          x: data.x,
          y: data.y,
          from: socket.id
        });
        console.log('coordenadas enviadas', {
          x: data.x,
          y: data.y,
          from: socket.id
        })
      }
    });

    socket.on("disconnect", (reason) => {
      console.log(`Cliente ${socket.id} desconectado: ${reason}`);
    });
  });
}
