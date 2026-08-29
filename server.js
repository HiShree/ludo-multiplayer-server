const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const publicQueues = {
  2: [],
  3: [],
  4: []
};

const rooms = {};

const COLORS = ["Blue", "Red", "Green", "Yellow"];

function randomRoomCode() {
  let code;

  do {
    code = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();
  } while (rooms[code]);

  return code;
}

function randomRoll() {
  return [1, 1, 2, 2, 3, 3, 4, 8][
    Math.floor(Math.random() * 8)
  ];
}

function removeFromQueues(socketId) {
  for (const key of Object.keys(publicQueues)) {
    publicQueues[key] = publicQueues[key].filter(
      socket => socket.id !== socketId
    );
  }
}

function getRoom(socket) {
  if (socket.roomId && rooms[socket.roomId]) {
    return rooms[socket.roomId];
  }

  return null;
}

function getRoomId(socket) {
  return socket.roomId || null;
}

function createPlayer(id) {
  return {
    id,
    pawns: [0, 0, 0, 0],
    hasKilled: false,
    hasWon: false,
    winRank: 0
  };
}

function createRoom(roomId, sockets, maxPlayers, isPrivate) {
  const playerIds = [0, 1, 2, 3].slice(0, sockets.length);

  const room = {
    id: roomId,
    maxPlayers,
    isPrivate,
    started: true,

    sockets: sockets.map((socket, index) => ({
      socketId: socket.id,
      playerId: playerIds[index]
    })),

    players: playerIds.map(createPlayer),

    activePlayerIndex: 0,
    activeRolls: [],
    canRoll: true,
    currentRank: 1
  };

  rooms[roomId] = room;

  sockets.forEach((socket, index) => {
    socket.roomId = roomId;
    socket.playerId = playerIds[index];

    socket.join(roomId);

    socket.emit("assignPlayer", playerIds[index]);
  });

  io.to(roomId).emit("gameStart", playerIds);

  io.to(roomId).emit(
    "systemMessage",
    "Match started! Blue goes first."
  );

  sendState(room);
}

function getCurrentPlayer(room) {
  return room.players[room.activePlayerIndex];
}

function getNextActivePlayer(room) {
  if (!room.players.length) return;

  let attempts = 0;

  do {
    room.activePlayerIndex =
      (room.activePlayerIndex + 1) % room.players.length;

    attempts++;
  } while (
    room.players[room.activePlayerIndex].hasWon &&
    attempts < room.players.length + 1
  );
}

function sendState(room) {
  io.to(room.id).emit("forceSync", {
    activeIndex: room.activePlayerIndex,
    activeRolls: room.activeRolls,
    canRoll: room.canRoll,
    players: room.players
  });
}

function advanceTurn(room) {
  room.activeRolls = [];
  room.canRoll = true;

  getNextActivePlayer(room);

  const player = getCurrentPlayer(room);

  if (!player) return;

  io.to(room.id).emit(
    "systemMessage",
    `${COLORS[player.id]}'s turn.`
  );

  sendState(room);
}

function validMove(player, pawnIndex, roll) {
  if (!player) return false;
  if (pawnIndex < 0 || pawnIndex > 3) return false;

  const step = player.pawns[pawnIndex];

  const maximum = player.hasKilled ? 24 : 15;

  return step + roll <= maximum;
}

io.on("connection", socket => {
  console.log(`User connected: ${socket.id}`);

  /*
   * PUBLIC MATCHMAKING
   */

  socket.on("joinGame", numPlayers => {
    numPlayers = Number(numPlayers);

    if (![2, 3, 4].includes(numPlayers)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    removeFromQueues(socket.id);

    publicQueues[numPlayers].push(socket);

    const queue = publicQueues[numPlayers];

    if (queue.length >= numPlayers) {
      const matchedSockets = queue.splice(0, numPlayers);

      const roomId =
        "pub_" +
        Math.random()
          .toString(36)
          .substring(2, 8);

      createRoom(
        roomId,
        matchedSockets,
        numPlayers,
        false
      );
    } else {
      socket.emit(
        "systemMessage",
        `Waiting for ${
          numPlayers - queue.length
        } more player(s)...`
      );
    }
  });

  /*
   * PRIVATE ROOM CREATION
   */

  socket.on("createPrivateGame", numPlayers => {
    numPlayers = Number(numPlayers);

    if (![2, 3, 4].includes(numPlayers)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    removeFromQueues(socket.id);

    const code = randomRoomCode();

    rooms[code] = {
      id: code,
      maxPlayers: numPlayers,
      isPrivate: true,
      started: false,

      sockets: [
        {
          socketId: socket.id,
          playerId: 0
        }
      ],

      players: [],

      activePlayerIndex: 0,
      activeRolls: [],
      canRoll: true,
      currentRank: 1
    };

    socket.roomId = code;
    socket.playerId = 0;

    socket.join(code);

    socket.emit("assignPlayer", 0);
    socket.emit("privateRoomCreated", code);

    io.to(code).emit(
      "systemMessage",
      `Room ${code} created. Waiting for players...`
    );
  });

  /*
   * JOIN PRIVATE ROOM
   */

  socket.on("joinPrivateGame", code => {
    code = String(code || "")
      .trim()
      .toUpperCase();

    const room = rooms[code];

    if (!room) {
      socket.emit(
        "roomError",
        "Room code not found!"
      );
      return;
    }

    if (room.started) {
      socket.emit(
        "roomError",
        "Game has already started!"
      );
      return;
    }

    if (room.sockets.length >= room.maxPlayers) {
      socket.emit(
        "roomError",
        "Room is full!"
      );
      return;
    }

    removeFromQueues(socket.id);

    const newPlayerId = room.sockets.length;

    room.sockets.push({
      socketId: socket.id,
      playerId: newPlayerId
    });

    socket.roomId = code;
    socket.playerId = newPlayerId;

    socket.join(code);

    socket.emit("assignPlayer", newPlayerId);

    io.to(code).emit(
      "systemMessage",
      `Player joined (${room.sockets.length}/${room.maxPlayers})...`
    );

    if (room.sockets.length === room.maxPlayers) {
      room.started = true;

      room.players = room.sockets.map(
        entry => createPlayer(entry.playerId)
      );

      io.to(code).emit(
        "gameStart",
        room.players.map(player => player.id)
      );

      io.to(code).emit(
        "systemMessage",
        "Match started! Blue goes first."
      );

      sendState(room);
    }
  });

  /*
   * ROLL
   *
   * The server now decides the roll.
   * The client cannot send an arbitrary roll.
   */

  socket.on("requestRoll", () => {
    const room = getRoom(socket);

    if (!room || !room.started) return;

    const current = getCurrentPlayer(room);

    if (!current) return;

    if (socket.playerId !== current.id) {
      return;
    }

    if (!room.canRoll) {
      return;
    }

    room.canRoll = false;

    const rollValue = randomRoll();

    room.activeRolls.push(rollValue);

    io.to(room.id).emit("executeRoll", {
      playerId: current.id,
      rollValue
    });

    /*
     * 4 or 8 gives another roll opportunity.
     */

    if (rollValue === 4 || rollValue === 8) {
      room.canRoll = true;
    }

    sendState(room);
  });

  /*
   * MOVE
   */

  socket.on("requestMove", data => {
    const room = getRoom(socket);

    if (!room || !room.started) return;

    const current = getCurrentPlayer(room);

    if (!current) return;

    if (socket.playerId !== current.id) {
      return;
    }

    if (!Array.isArray(room.activeRolls)) {
      return;
    }

    if (room.activeRolls.length === 0) {
      return;
    }

    const pawnIndex = Number(data.pawnIndex);

    const roll = room.activeRolls[0];

    if (!validMove(current, pawnIndex, roll)) {
      socket.emit(
        "systemMessage",
        "That pawn cannot move."
      );

      return;
    }

    room.activeRolls.shift();

    current.pawns[pawnIndex] += roll;

    const pawnReachedHome =
      current.pawns[pawnIndex] >= 24;

    let captured = false;

    /*
     * The actual board path/capture rules are handled
     * on the client, but the server still validates
     * the player and move distance.
     */

    if (pawnReachedHome) {
      current.pawns[pawnIndex] = 24;
    }

    io.to(room.id).emit("executeMove", {
      playerId: current.id,
      pawnIndex,
      rollValue: roll,
      newStep: current.pawns[pawnIndex]
    });

    /*
     * If every pawn reached home,
     * player finishes the match.
     */

    if (current.pawns.every(step => step === 24)) {
      current.hasWon = true;
      current.winRank = room.currentRank++;

      io.to(room.id).emit("playerWon", {
        playerId: current.id,
        rank: current.winRank
      });

      if (
        room.players.filter(p => !p.hasWon).length <= 1
      ) {
        io.to(room.id).emit(
          "systemMessage",
          "Game finished!"
        );

        sendState(room);
        return;
      }

      advanceTurn(room);
      return;
    }

    /*
     * If rolls remain, player must use them.
     */

    if (room.activeRolls.length > 0) {
      room.canRoll = false;
      sendState(room);
      return;
    }

    /*
     * No rolls left.
     * Normal move ends the turn.
     */

    advanceTurn(room);
  });

  /*
   * CHAT
   */

  socket.on("sendChatMessage", data => {
    const room = getRoom(socket);

    if (!room) return;

    const text = String(data?.text || "")
      .trim()
      .substring(0, 250);

    if (!text) return;

    const player = COLORS[socket.playerId] || "Player";

    io.to(room.id).emit(
      "receiveChatMessage",
      {
        name: player,
        text
      }
    );
  });

  /*
   * VOICE
   */

  socket.on("voiceData", audioData => {
    const room = getRoom(socket);

    if (!room) return;

    socket.to(room.id).emit(
      "voiceData",
      audioData
    );
  });

  /*
   * DISCONNECT
   */

  socket.on("disconnect", () => {
    console.log(
      `User disconnected: ${socket.id}`
    );

    removeFromQueues(socket.id);

    const roomId = socket.roomId;

    if (!roomId || !rooms[roomId]) {
      return;
    }

    const room = rooms[roomId];

    room.sockets = room.sockets.filter(
      entry => entry.socketId !== socket.id
    );

    socket.leave(roomId);

    /*
     * If a private room has not started,
     * keep it alive for the remaining players.
     */

    if (!room.started) {
      if (room.sockets.length === 0) {
        delete rooms[roomId];
      }

      return;
    }

    /*
     * Remove disconnected player from active game.
     */

    const disconnectedId = socket.playerId;

    room.players = room.players.filter(
      player => player.id !== disconnectedId
    );

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }

    /*
     * Rebuild active player index safely.
     */

    if (
      room.activePlayerIndex >=
      room.players.length
    ) {
      room.activePlayerIndex = 0;
    }

    io.to(roomId).emit(
      "systemMessage",
      `${COLORS[disconnectedId]} disconnected.`
    );

    sendState(room);
  });
});

server.listen(PORT, () => {
  console.log(
    `Server running on http://localhost:${PORT}`
  );
});
