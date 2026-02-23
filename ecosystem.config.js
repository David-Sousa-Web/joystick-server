module.exports = {
  apps: [{
    name: "websocket-server-galaga-pong",
    script: "npm",
    args: "start",
    autorestart: true,
    restart_delay: 5000,
  }]
};