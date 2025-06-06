import express, { Request, Response } from 'express';
import http from 'http';
import { env } from "./env";
import { Server } from 'socket.io';
import { setupSocket } from './config/socket';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const port = env.PORT;

app.get('/', (req: Request, res: Response) => {
  res.send('API Online');
});

setupSocket(io);

server.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
