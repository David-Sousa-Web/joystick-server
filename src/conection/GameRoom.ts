import { WebSocket } from "ws";

export type GameType = 'pong' | 'galaga';

interface PlayerInfo {
  socketId: string;
  playerNumber: number;
  ws?: WebSocket;
}

export class GameRoom {
  readonly roomId: string;
  readonly gameType: GameType;
  minPlayers: number;
  maxPlayers: number;

  hostSocketId: string;
  hostWs?: WebSocket;
  players: Map<string, PlayerInfo> = new Map();

  constructor(roomId: string, gameType: GameType, hostSocketId: string) {
    this.roomId = roomId;
    this.gameType = gameType;
    this.hostSocketId = hostSocketId;

    this.maxPlayers = 2;
    this.minPlayers = gameType === 'pong' ? 2 : 1;
  }

  addPlayer(socketId: string): PlayerInfo | null {
    if (this.isFull()) return null;

    const playerNumber = this.players.size + 1;
    const player: PlayerInfo = { socketId, playerNumber };
    this.players.set(socketId, player);
    return player;
  }

  removePlayer(socketId: string): PlayerInfo | null {
    const player = this.players.get(socketId);
    if (!player) return null;

    this.players.delete(socketId);

    // Renumber remaining players sequentially
    let num = 1;
    for (const [, p] of this.players) {
      p.playerNumber = num++;
    }

    return player;
  }

  getPlayer(socketId: string): PlayerInfo | undefined {
    return this.players.get(socketId);
  }

  isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  isReady(): boolean {
    return this.players.size >= this.minPlayers;
  }

  playerCount(): number {
    return this.players.size;
  }

  setMaxPlayers(max: number) {
    this.maxPlayers = max;
  }
}
