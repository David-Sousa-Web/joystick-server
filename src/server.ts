import express, { Request, Response } from 'express';
import http from 'http';
import { env } from "./env";
import { setupPong } from './conection/pong';
import { setupGalaga } from './conection/galaga';

const app = express();
const server = http.createServer(app);
const port = env.PORT;

app.get('/', (req: Request, res: Response) => {
  res.send('API Online');
});

// Setup game WebSocket handlers with path-based routing
setupPong(server);
setupGalaga(server);

server.listen(port, '0.0.0.0', () => console.log(`Servidor rodando em http://0.0.0.0:${port}`));
