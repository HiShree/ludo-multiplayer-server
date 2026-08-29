const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const queues = {
  2: [],
  3: [],
  4: []
};

const rooms = new Map();

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function removeFromQueues(id) {
  for (const n of [2, 3, 4]) {
    queues[n] = queues[n].filter(s => s.id !== id);
  }
}

function getRoom(socket) {
  const id = socket.data.roomId;
  return id ? rooms.get(id) : null;
}

function createRoom(id, maxPlayers, isPrivate) {
  rooms.set(id, {
    id,
    maxPlayers,
    sockets: [],
    started: false,

    // Server-side turn protection
    activeIndex: 0,
    rolls: [],
    canRoll: true,
    busy: false
  });
}

function setupRoom(roomId, sockets) {
  const room = rooms.get(roomId);
  if (!room) return;

  const ids = [0, 1, 2, 3].slice(0, sockets.length);

  room.started = true;
  room.activeIndex = 0;
  room.rolls = [];
  room.canRoll = true;
  room.busy = false;
  room.sockets = sockets;

  sockets.forEach((socket, index) => {
    socket.data.roomId = roomId;
    socket.data.playerIndex = ids[index];

    socket.join(roomId);

    socket.emit("assignPlayer", ids[index]);
  });

  io.to(roomId).emit("gameStart", ids);
  io.to(roomId).emit(
    "systemMessage",
    "Match started! Blue goes first."
  );
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  // =========================
  // PUBLIC MATCHMAKING
  // =========================

  socket.on("joinGame", num => {
    num = Number(num);

    removeFromQueues(socket.id);

    if (![2, 3, 4].includes(num)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    queues[num].push(socket);

    if (queues[num].length >= num) {
      const group = queues[num].splice(0, num);

      const roomId = "pub_" + makeCode().toLowerCase();

      createRoom(roomId, num, false);
      setupRoom(roomId, group);
    } else {
      socket.emit(
        "systemMessage",
        `Waiting for ${num - queues[num].length} more players...`
      );
    }
  });

  // =========================
  // PRIVATE ROOM
  // =========================

  socket.on("createPrivateGame", num => {
    num = Number(num);

    removeFromQueues(socket.id);

    if (![2, 3, 4].includes(num)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    const roomId = makeCode();

    createRoom(roomId, num, true);

    const room = rooms.get(roomId);

    room.sockets.push(socket);

    socket.data.roomId = roomId;
    socket.data.playerIndex = 0;

    socket.join(roomId);

    socket.emit("assignPlayer", 0);
    socket.emit("privateRoomCreated", roomId);

    socket.emit(
      "systemMessage",
      `Waiting for players (1/${num})...`
    );
  });

  socket.on("joinPrivateGame", code => {
    const roomId = String(code || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("roomError", "Room code not found!");
      return;
    }

    if (room.started) {
      socket.emit("roomError", "Game has already started!");
      return;
    }

    if (room.sockets.length >= room.maxPlayers) {
      socket.emit("roomError", "Room is full!");
      return;
    }

    removeFromQueues(socket.id);

    room.sockets.push(socket);

    socket.data.roomId = roomId;
    socket.data.playerIndex = room.sockets.length - 1;

    socket.join(roomId);

    io.to(roomId).emit(
      "systemMessage",
      `Player joined (${room.sockets.length}/${room.maxPlayers})...`
    );

    if (room.sockets.length === room.maxPlayers) {
      setupRoom(roomId, room.sockets);
    }
  });

  // =========================
  // AUTHORITATIVE DICE
  // =========================

  socket.on("requestRoll", () => {
    const room = getRoom(socket);

    if (!room || !room.started) return;

    const playerId = socket.data.playerIndex;

    // Not your turn
    if (playerId !== room.activeIndex) return;

    // Animation still running
    if (room.busy) return;

    // Already rolled and no extra roll
    if (!room.canRoll) return;

    const values = [1, 1, 2, 2, 3, 3, 4, 8];

    const value =
      values[Math.floor(Math.random() * values.length)];

    room.rolls.push(value);

    // Only 4 and 8 give an additional roll.
    room.canRoll = value === 4 || value === 8;

    io.to(room.id).emit("executeRoll", {
      playerId,
      rollValue: value
    });
  });

  // =========================
  // AUTHORITATIVE MOVE
  // =========================

  socket.on("requestMove", data => {
    const room = getRoom(socket);

    if (!room || !room.started) return;

    const playerId = socket.data.playerIndex;

    if (playerId !== room.activeIndex) return;

    if (room.busy) return;

    if (!room.rolls.length) return;

    const pawnIndex = Number(data?.pawnIndex);

    if (
      !Number.isInteger(pawnIndex) ||
      pawnIndex < 0 ||
      pawnIndex > 3
    ) {
      return;
    }

    // Lock the room while the pawn animation happens.
    room.busy = true;

    // Consume exactly one server-side roll.
    room.rolls.shift();

    io.to(room.id).emit("executeMove", {
      playerId,
      pawnIndex
    });
  });

  // =========================
  // CLIENT STATE SYNC
  // =========================

  socket.on("syncState", state => {
    const room = getRoom(socket);

    if (!room || !room.started) return;

    // Only current player can advance the state.
    if (socket.data.playerIndex !== room.activeIndex) {
      return;
    }

    if (!state || !Array.isArray(state.players)) {
      return;
    }

    if (
      Number.isInteger(state.activeIndex) &&
      state.activeIndex >= 0 &&
      state.activeIndex < room.maxPlayers
    ) {
      room.activeIndex = state.activeIndex;
    }

    room.rolls = Array.isArray(state.rolls)
      ? state.rolls.slice(0, 8)
      : [];

    room.canRoll = Boolean(state.canRoll);

    // Unlock after client finishes animation.
    room.busy = false;

    socket.to(room.id).emit("forceSync", state);
  });

  // =========================
  // CHAT
  // =========================

  socket.on("sendChatMessage", data => {
    const room = getRoom(socket);

    if (!room) return;

    const name = String(data?.name || "Player").slice(0, 30);
    const text = String(data?.text || "").slice(0, 300);

    if (!text.trim()) return;

    io.to(room.id).emit("receiveChatMessage", {
      name,
      text
    });
  });

  // =========================
  // WEBRTC VOICE
  // =========================

  socket.on("voiceJoin", () => {
    const room = getRoom(socket);

    if (!room) return;

    socket.emit(
      "voicePeers",
      room.sockets
        .filter(s => s.id !== socket.id)
        .map(s => s.id)
    );
  });

  socket.on("voiceSignal", message => {
    const room = getRoom(socket);

    if (!room || !message?.to) return;

    const target = room.sockets.find(
      s => s.id === message.to
    );

    if (!target) return;

    target.emit("voiceSignal", {
      from: socket.id,
      data: message.data
    });
  });

  // =========================
  // DISCONNECT
  // =========================

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    removeFromQueues(socket.id);

    const room = getRoom(socket);

    if (!room) return;

    room.sockets = room.sockets.filter(
      s => s.id !== socket.id
    );

    if (room.sockets.length === 0) {
      rooms.delete(room.id);
      return;
    }

    if (!room.started) {
      io.to(room.id).emit(
        "systemMessage",
        `Player left (${room.sockets.length}/${room.maxPlayers})...`
      );
      return;
    }

    io.to(room.id).emit(
      "systemMessage",
      "A player disconnected. The room has ended."
    );

    for (const s of room.sockets) {
      s.leave(room.id);
      s.data.roomId = null;
      s.data.playerIndex = null;
    }

    rooms.delete(room.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Ludo Twist server running on port ${PORT}`
  );
});
