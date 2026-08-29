const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const publicQueues = {
  2: [],
  3: [],
  4: []
};

const rooms = new Map();

const COLORS = ["Blue", "Red", "Green", "Yellow"];

/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function removeFromQueues(socketId) {
  for (const key of Object.keys(publicQueues)) {
    publicQueues[key] = publicQueues[key].filter(
      s => s && s.id !== socketId
    );
  }
}

function getRoom(socket) {
  if (!socket.roomId) return null;
  return rooms.get(socket.roomId) || null;
}

function randomRoomCode() {
  let code;

  do {
    code = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function randomRoll() {
  return [1, 1, 2, 2, 3, 3, 4, 8][
    Math.floor(Math.random() * 8)
  ];
}

/* -------------------------------------------------------
   ROOM STATE
------------------------------------------------------- */

function createRoom(roomId, sockets, maxPlayers, isPrivate) {
  const players = sockets.map((socket, index) => ({
    id: index,
    socketId: socket.id,
    name: COLORS[index],
    pawns: [0, 0, 0, 0],
    hasKilled: false,
    hasWon: false,
    winRank: 0
  }));

  const room = {
    id: roomId,
    maxPlayers,
    isPrivate,
    started: true,

    players,

    activePlayerIndex: 0,

    // Roll waiting for a pawn move.
    pendingRoll: null,

    // Prevent duplicate requests.
    actionLocked: false,

    currentActionId: 0
  };

  rooms.set(roomId, room);

  sockets.forEach((socket, index) => {
    socket.roomId = roomId;
    socket.playerIndex = index;
    socket.join(roomId);

    socket.emit("assignPlayer", index);
  });

  io.to(roomId).emit(
    "gameStart",
    players.map(p => p.id)
  );

  io.to(roomId).emit("serverState", makeClientState(room));

  io.to(roomId).emit(
    "systemMessage",
    "Match started! Blue goes first."
  );

  log("Room started:", roomId);
}

function makeClientState(room) {
  return {
    activePlayerIndex: room.activePlayerIndex,

    pendingRoll: room.pendingRoll,

    actionLocked: room.actionLocked,

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      pawns: [...p.pawns],
      hasKilled: p.hasKilled,
      hasWon: p.hasWon,
      winRank: p.winRank
    }))
  };
}

function broadcastState(room) {
  io.to(room.id).emit(
    "serverState",
    makeClientState(room)
  );
}

function currentPlayer(room) {
  return room.players[room.activePlayerIndex];
}

function nextPlayer(room) {
  if (!room.players.length) return;

  let attempts = 0;

  do {
    room.activePlayerIndex =
      (room.activePlayerIndex + 1) %
      room.players.length;

    attempts++;

    if (attempts > room.players.length) break;
  } while (
    room.players[room.activePlayerIndex].hasWon
  );

  room.pendingRoll = null;
  room.actionLocked = false;
}

function hasValidMove(player, roll) {
  return player.pawns.some(step => {
    if (player.hasKilled) {
      return step + roll <= 24;
    }

    return step + roll <= 15;
  });
}

/* -------------------------------------------------------
   CONNECTION
------------------------------------------------------- */

io.on("connection", socket => {
  log("User connected:", socket.id);

  /* ---------------------------------------------------
     PUBLIC MATCHMAKING
  --------------------------------------------------- */

  socket.on("joinGame", numPlayers => {
    numPlayers = Number(numPlayers);

    if (![2, 3, 4].includes(numPlayers)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    removeFromQueues(socket.id);

    publicQueues[numPlayers].push(socket);

    const waiting =
      publicQueues[numPlayers].length;

    if (waiting >= numPlayers) {
      const matchedSockets =
        publicQueues[numPlayers].splice(
          0,
          numPlayers
        );

      const roomId =
        "PUB_" +
        Math.random()
          .toString(36)
          .substring(2, 8)
          .toUpperCase();

      matchedSockets.forEach(s => {
        s.roomId = roomId;
      });

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
          numPlayers - waiting
        } more player(s)...`
      );
    }
  });

  /* ---------------------------------------------------
     CREATE PRIVATE ROOM
  --------------------------------------------------- */

  socket.on("createPrivateGame", numPlayers => {
    numPlayers = Number(numPlayers);

    if (![2, 3, 4].includes(numPlayers)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    removeFromQueues(socket.id);

    const code = randomRoomCode();

    const room = {
      id: code,
      maxPlayers: numPlayers,
      isPrivate: true,
      started: false,

      players: [],

      activePlayerIndex: 0,
      pendingRoll: null,
      actionLocked: false,
      currentActionId: 0
    };

    rooms.set(code, room);

    room.players.push({
      id: 0,
      socketId: socket.id,
      name: COLORS[0],
      pawns: [0, 0, 0, 0],
      hasKilled: false,
      hasWon: false,
      winRank: 0
    });

    socket.roomId = code;
    socket.playerIndex = 0;
    socket.join(code);

    socket.emit("assignPlayer", 0);
    socket.emit("privateRoomCreated", code);

    io.to(code).emit(
      "systemMessage",
      `Room created. Code: ${code}`
    );

    broadcastState(room);

    log("Private room created:", code);
  });

  /* ---------------------------------------------------
     JOIN PRIVATE ROOM
  --------------------------------------------------- */

  socket.on("joinPrivateGame", rawCode => {
    const code = String(rawCode || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      socket.emit(
        "roomError",
        "Room code not found!"
      );
      return;
    }

    if (!room.isPrivate) {
      socket.emit(
        "roomError",
        "Invalid private room."
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

    if (
      room.players.length >=
      room.maxPlayers
    ) {
      socket.emit(
        "roomError",
        "Room is full!"
      );
      return;
    }

    removeFromQueues(socket.id);

    const playerId = room.players.length;

    room.players.push({
      id: playerId,
      socketId: socket.id,
      name: COLORS[playerId],
      pawns: [0, 0, 0, 0],
      hasKilled: false,
      hasWon: false,
      winRank: 0
    });

    socket.roomId = code;
    socket.playerIndex = playerId;
    socket.join(code);

    socket.emit(
      "assignPlayer",
      playerId
    );

    io.to(code).emit(
      "systemMessage",
      `Player joined (${room.players.length}/${room.maxPlayers})`
    );

    if (
      room.players.length ===
      room.maxPlayers
    ) {
      room.started = true;

      io.to(code).emit(
        "gameStart",
        room.players.map(p => p.id)
      );

      io.to(code).emit(
        "systemMessage",
        "Match started! Blue goes first."
      );
    }

    broadcastState(room);
  });

  /* ---------------------------------------------------
     CHAT
  --------------------------------------------------- */

  socket.on("sendChatMessage", data => {
    const room = getRoom(socket);

    if (!room) return;

    const player =
      room.players.find(
        p => p.socketId === socket.id
      );

    if (!player) return;

    const text =
      typeof data?.text === "string"
        ? data.text.trim().substring(0, 300)
        : "";

    if (!text) return;

    io.to(room.id).emit(
      "receiveChatMessage",
      {
        id: player.id,
        name: player.name,
        text
      }
    );
  });

  /* ---------------------------------------------------
     MICROPHONE STREAM
  --------------------------------------------------- */

  socket.on("voiceData", audioData => {
    const room = getRoom(socket);

    if (!room) return;

    // Forward ONLY to other players.
    socket.to(room.id).emit(
      "voiceData",
      audioData
    );
  });

  /* ---------------------------------------------------
     ROLL
  --------------------------------------------------- */

  socket.on("requestRoll", () => {
    const room = getRoom(socket);

    if (!room || !room.started) return;

    const player =
      room.players[room.activePlayerIndex];

    if (!player) return;

    // Only the actual current player can roll.
    if (
      player.socketId !== socket.id
    ) {
      return;
    }

    // Never accept a second roll while
    // a previous roll is waiting.
    if (
      room.actionLocked ||
      room.pendingRoll !== null
    ) {
      return;
    }

    room.actionLocked = true;

    const roll = randomRoll();

    room.pendingRoll = roll;

    room.currentActionId++;

    const actionId =
      room.currentActionId;

    io.to(room.id).emit(
      "executeRoll",
      {
        playerId: player.id,
        rollValue: roll,
        actionId
      }
    );

    // Check whether this roll has a legal move.
    if (!hasValidMove(player, roll)) {
      room.pendingRoll = null;
      room.actionLocked = true;

      broadcastState(room);

      setTimeout(() => {
        const freshRoom = rooms.get(room.id);

        if (!freshRoom) return;

        // Move to next player.
        nextPlayer(freshRoom);

        broadcastState(freshRoom);
      }, 900);

      return;
    }

    // The client now needs to choose a pawn.
    room.actionLocked = false;

    broadcastState(room);
  });

  /* ---------------------------------------------------
     MOVE
  --------------------------------------------------- */

  socket.on("requestMove", data => {
    const room = getRoom(socket);

    if (!room || !room.started) return;

    const player =
      room.players[room.activePlayerIndex];

    if (!player) return;

    // Important: only the current player's
    // own socket can make the move.
    if (
      player.socketId !== socket.id
    ) {
      return;
    }

    if (room.pendingRoll === null) {
      return;
    }

    const pawnIndex =
      Number(data?.pawnIndex);

    if (
      !Number.isInteger(pawnIndex) ||
      pawnIndex < 0 ||
      pawnIndex > 3
    ) {
      return;
    }

    const roll = room.pendingRoll;

    const currentStep =
      player.pawns[pawnIndex];

    const maxStep =
      player.hasKilled ? 24 : 15;

    if (
      currentStep + roll >
      maxStep
    ) {
      return;
    }

    // Lock immediately.
    room.actionLocked = true;

    room.pendingRoll = null;

    room.currentActionId++;

    const actionId =
      room.currentActionId;

    const oldStep = currentStep;

    const newStep =
      Math.min(
        24,
        currentStep + roll
      );

    player.pawns[pawnIndex] =
      newStep;

    let captured = false;

    const finalCell =
      getPathCell(
        player.id,
        newStep
      );

    // Safe cells.
    const safeCells = [
      2,
      10,
      12,
      14,
      22
    ];

    if (
      !safeCells.includes(finalCell)
    ) {
      for (const opponent of room.players) {
        if (
          opponent.id === player.id ||
          opponent.hasWon
        ) {
          continue;
        }

        for (
          let i = 0;
          i < opponent.pawns.length;
          i++
        ) {
          const opponentStep =
            opponent.pawns[i];

          if (
            opponentStep >= 24
          ) {
            continue;
          }

          const opponentCell =
            getPathCell(
              opponent.id,
              opponentStep
            );

          if (
            opponentCell === finalCell
          ) {
            opponent.pawns[i] = 0;
            captured = true;
            player.hasKilled = true;
          }
        }
      }
    }

    // Reaching the end.
    let finishedPawn = false;

    if (newStep >= 24) {
      finishedPawn = true;
    }

    let won = false;

    if (
      player.pawns.every(
        step => step >= 24
      )
    ) {
      player.hasWon = true;

      const wonPlayers =
        room.players.filter(
          p => p.hasWon
        );

      player.winRank =
        wonPlayers.length;

      won = true;
    }

    io.to(room.id).emit(
      "executeMove",
      {
        playerId: player.id,
        pawnIndex,
        fromStep: oldStep,
        toStep: newStep,
        roll,
        captured,
        finishedPawn,
        won,
        actionId
      }
    );

    /*
      Turn rules:

      4 / 8 = extra turn
      capture = extra turn
      reaching home = extra turn

      Normal roll = next player
    */

    const extraTurn =
      roll === 4 ||
      roll === 8 ||
      captured ||
      finishedPawn;

    if (won) {
      setTimeout(() => {
        const freshRoom =
          rooms.get(room.id);

        if (!freshRoom) return;

        const remaining =
          freshRoom.players.filter(
            p => !p.hasWon
          );

        if (remaining.length === 0) {
          io.to(room.id).emit(
            "gameFinished"
          );
          return;
        }

        nextPlayer(freshRoom);

        broadcastState(freshRoom);
      }, 1100);

      return;
    }

    if (extraTurn) {
      room.actionLocked = false;

      setTimeout(() => {
        const freshRoom =
          rooms.get(room.id);

        if (!freshRoom) return;

        broadcastState(freshRoom);
      }, 350);
    } else {
      setTimeout(() => {
        const freshRoom =
          rooms.get(room.id);

        if (!freshRoom) return;

        nextPlayer(freshRoom);

        broadcastState(freshRoom);
      }, 450);
    }
  });

  /* ---------------------------------------------------
     RESYNC
  --------------------------------------------------- */

  socket.on("requestSync", () => {
    const room = getRoom(socket);

    if (!room) return;

    socket.emit(
      "serverState",
      makeClientState(room)
    );
  });

  /* ---------------------------------------------------
     DISCONNECT
  --------------------------------------------------- */

  socket.on("disconnect", () => {
    removeFromQueues(socket.id);

    const room =
      socket.roomId
        ? rooms.get(socket.roomId)
        : null;

    if (room) {
      const player =
        room.players.find(
          p => p.socketId === socket.id
        );

      io.to(room.id).emit(
        "systemMessage",
        player
          ? `${player.name} disconnected.`
          : "A player disconnected."
      );

      // End the room instead of allowing
      // corrupted turns to continue.
      rooms.delete(room.id);
    }

    log(
      "User disconnected:",
      socket.id
    );
  });
});

/* -------------------------------------------------------
   BOARD PATHS
------------------------------------------------------- */

const paths = {
  0: [
    10,15,20,21,22,
    23,24,19,14,9,
    4,3,2,1,0,5,
    6,7,8,13,18,17,
    16,11,12
  ],

  1: [
    2,1,0,5,10,
    15,20,21,22,23,
    24,19,14,9,4,3,
    8,13,18,17,16,
    11,6,7,12
  ],

  2: [
    14,9,4,3,2,
    1,0,5,10,15,
    20,21,22,23,24,
    19,18,17,16,11,
    6,7,8,13,12
  ],

  3: [
    22,23,24,19,14,
    9,4,3,2,1,
    0,5,10,15,20,21,
    16,11,6,7,8,13,
    18,17,12
  ]
};

function getPathCell(playerId, step) {
  const path = paths[playerId];

  if (!path) return 12;

  return path[
    Math.min(
      Math.max(step, 0),
      path.length - 1
    )
  ];
}

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

server.listen(PORT, () => {
  log(
    `Server running on http://localhost:${PORT}`
  );
});
