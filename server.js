const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
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

const PLAYER_INFO = [
  {
    id: 0,
    name: "Blue",
    color: "#1e90ff",
    path: [
      10, 15, 20, 21, 22,
      23, 24, 19, 14, 9,
      4, 3, 2, 1, 0,
      5, 6, 7, 8, 13,
      18, 17, 16, 11, 12
    ]
  },
  {
    id: 1,
    name: "Red",
    color: "#ff4757",
    path: [
      2, 1, 0, 5, 10,
      15, 20, 21, 22, 23,
      24, 19, 14, 9, 4,
      3, 8, 13, 18, 17,
      16, 11, 6, 7, 12
    ]
  },
  {
    id: 2,
    name: "Green",
    color: "#2ed573",
    path: [
      14, 9, 4, 3, 2,
      1, 0, 5, 10, 15,
      20, 21, 22, 23, 24,
      19, 18, 17, 16, 11,
      6, 7, 8, 13, 12
    ]
  },
  {
    id: 3,
    name: "Yellow",
    color: "#ffa502",
    path: [
      22, 23, 24, 19, 14,
      9, 4, 3, 2, 1,
      0, 5, 10, 15, 20,
      21, 16, 11, 6, 7,
      8, 13, 18, 17, 12
    ]
  }
];

const SAFE_CELLS = new Set([2, 10, 14, 22, 12]);

function createPlayer(id, socketId) {
  const info = PLAYER_INFO[id];

  return {
    id,
    name: info.name,
    color: info.color,
    path: info.path,
    socketId,
    pawns: [0, 0, 0, 0],
    hasKilled: false,
    hasWon: false,
    winRank: 0
  };
}

function createGame(roomId, sockets) {
  const ids = sockets.map((_, index) => index);

  const players = ids.map((id, index) =>
    createPlayer(id, sockets[index].id)
  );

  const game = {
    roomId,
    maxPlayers: sockets.length,
    started: true,
    players,

    activeIndex: 0,

    // The current player can have multiple rolls because
    // 4 and 8 grant another roll.
    pendingRolls: [],

    canRoll: true,

    rankCounter: 1,

    // Prevents duplicate requests during animation.
    moveLocked: false
  };

  rooms.set(roomId, game);

  sockets.forEach((socket, index) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = ids[index];

    socket.emit("assignPlayer", ids[index]);
  });

  io.to(roomId).emit("gameStart", {
    players: ids,
    state: publicState(game)
  });

  io.to(roomId).emit(
    "systemMessage",
    "Match started! Blue goes first."
  );

  broadcastState(game);
}

function publicState(game) {
  return {
    activeIndex: game.activeIndex,
    pendingRolls: [...game.pendingRolls],
    canRoll: game.canRoll,
    moveLocked: game.moveLocked,

    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      pawns: [...p.pawns],
      hasKilled: p.hasKilled,
      hasWon: p.hasWon,
      winRank: p.winRank
    }))
  };
}

function broadcastState(game) {
  io.to(game.roomId).emit("gameState", publicState(game));
}

function getGame(socket) {
  const roomId = socket.data.roomId;

  if (!roomId) return null;

  return rooms.get(roomId) || null;
}

function removeSocketFromQueues(socketId) {
  Object.keys(publicQueues).forEach(key => {
    publicQueues[key] = publicQueues[key].filter(
      socket => socket.id !== socketId
    );
  });
}

function leaveCurrentRoom(socket) {
  const room = getGame(socket);

  if (!room) return;

  room.players = room.players.filter(
    player => player.socketId !== socket.id
  );

  socket.leave(room.roomId);
  socket.data.roomId = null;
  socket.data.playerId = null;

  if (room.players.length === 0) {
    rooms.delete(room.roomId);
    return;
  }

  io.to(room.roomId).emit(
    "systemMessage",
    "A player disconnected. This room has ended."
  );

  io.to(room.roomId).emit("roomEnded");

  rooms.delete(room.roomId);
}

function randomRoll() {
  const values = [1, 1, 2, 2, 3, 3, 4, 8];
  return values[Math.floor(Math.random() * values.length)];
}

function currentPlayer(game) {
  return game.players[game.activeIndex];
}

function hasValidMove(player, roll) {
  return player.pawns.some(step => {
    return step + roll <= 24;
  });
}

function nextActivePlayer(game) {
  if (game.players.length === 0) return;

  let attempts = 0;

  do {
    game.activeIndex =
      (game.activeIndex + 1) % game.players.length;

    attempts++;

    if (attempts > game.players.length) break;

  } while (game.players[game.activeIndex].hasWon);

  game.pendingRolls = [];
  game.canRoll = true;
  game.moveLocked = false;
}

function checkPlayerWon(game, player) {
  if (player.pawns.every(step => step === 24)) {
    if (!player.hasWon) {
      player.hasWon = true;
      player.winRank = game.rankCounter++;
    }

    return true;
  }

  return false;
}

function performCapture(game, movingPlayer, finalCell) {
  if (SAFE_CELLS.has(finalCell)) {
    return false;
  }

  let captured = false;

  game.players.forEach(opponent => {
    if (opponent.id === movingPlayer.id) return;
    if (opponent.hasWon) return;

    opponent.pawns.forEach((step, index) => {
      if (step >= 24) return;

      const opponentCell = opponent.path[step];

      if (opponentCell === finalCell) {
        opponent.pawns[index] = 0;
        captured = true;
      }
    });
  });

  if (captured) {
    movingPlayer.hasKilled = true;
  }

  return captured;
}

/*
  PUBLIC MATCHMAKING
*/

io.on("connection", socket => {

  console.log("User connected:", socket.id);

  socket.on("joinGame", numPlayers => {

    numPlayers = Number(numPlayers);

    if (![2, 3, 4].includes(numPlayers)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    removeSocketFromQueues(socket.id);
    leaveCurrentRoom(socket);

    publicQueues[numPlayers].push(socket);

    const queueLength = publicQueues[numPlayers].length;

    if (queueLength >= numPlayers) {

      const matchedSockets =
        publicQueues[numPlayers].splice(0, numPlayers);

      const roomId =
        "pub_" +
        Math.random()
          .toString(36)
          .substring(2, 8);

      createGame(roomId, matchedSockets);

    } else {

      socket.emit(
        "systemMessage",
        `Waiting for ${numPlayers - queueLength} more player(s)...`
      );
    }
  });

  /*
    PRIVATE ROOM CREATION
  */

  socket.on("createPrivateGame", numPlayers => {

    numPlayers = Number(numPlayers);

    if (![2, 3, 4].includes(numPlayers)) {
      socket.emit("roomError", "Invalid player count.");
      return;
    }

    removeSocketFromQueues(socket.id);
    leaveCurrentRoom(socket);

    let code;

    do {
      code = Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();
    } while (rooms.has(code));

    const room = {
      roomId: code,
      maxPlayers: numPlayers,
      started: false,
      waitingSockets: [socket]
    };

    rooms.set(code, room);

    socket.join(code);

    socket.data.roomId = code;

    socket.emit("privateRoomCreated", code);

    io.to(code).emit(
      "systemMessage",
      `Private room created. Code: ${code}`
    );
  });

  /*
    PRIVATE ROOM JOIN
  */

  socket.on("joinPrivateGame", code => {

    code = String(code || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      socket.emit("roomError", "Room code not found.");
      return;
    }

    if (room.started) {
      socket.emit("roomError", "Game has already started.");
      return;
    }

    if (!room.waitingSockets) {
      socket.emit("roomError", "Room is unavailable.");
      return;
    }

    if (room.waitingSockets.length >= room.maxPlayers) {
      socket.emit("roomError", "Room is full.");
      return;
    }

    removeSocketFromQueues(socket.id);

    room.waitingSockets.push(socket);

    socket.join(code);
    socket.data.roomId = code;

    io.to(code).emit(
      "systemMessage",
      `Player joined (${room.waitingSockets.length}/${room.maxPlayers})...`
    );

    if (room.waitingSockets.length === room.maxPlayers) {

      const sockets = room.waitingSockets;

      rooms.delete(code);

      createGame(code, sockets);
    }
  });

  /*
    ROLL
    Server decides the roll.
  */

  socket.on("requestRoll", () => {

    const game = getGame(socket);

    if (!game) return;

    if (game.moveLocked) return;

    const playerId = socket.data.playerId;

    const player = currentPlayer(game);

    if (!player) return;

    if (player.id !== playerId) {
      socket.emit(
        "actionError",
        "It is not your turn."
      );
      return;
    }

    if (!game.canRoll) {
      socket.emit(
        "actionError",
        "You cannot roll right now."
      );
      return;
    }

    const roll = randomRoll();

    game.canRoll = false;

    game.pendingRolls.push(roll);

    io.to(game.roomId).emit("rollResult", {
      playerId,
      value: roll
    });

    /*
      A 4 or 8 immediately gives the player
      another roll.
    */
    if (roll === 4 || roll === 8) {
      game.canRoll = true;
    }

    /*
      If there is no possible move, automatically
      finish this roll/turn.
    */
    if (!hasValidMove(player, roll)) {

      game.pendingRolls.shift();

      io.to(game.roomId).emit(
        "systemMessage",
        `${player.name} rolled ${roll}. No valid move.`
      );

      if (!game.canRoll) {
        nextActivePlayer(game);
      }

    } else {

      io.to(game.roomId).emit(
        "systemMessage",
        `${player.name} rolled ${roll}.`
      );
    }

    broadcastState(game);
  });

  /*
    MOVE
  */

  socket.on("requestMove", data => {

    const game = getGame(socket);

    if (!game) return;

    if (game.moveLocked) return;

    const playerId = socket.data.playerId;

    if (Number(data.playerId) !== playerId) {
      socket.emit(
        "actionError",
        "You cannot move another player's pawn."
      );
      return;
    }

    const player = currentPlayer(game);

    if (!player || player.id !== playerId) {
      socket.emit(
        "actionError",
        "It is not your turn."
      );
      return;
    }

    const pawnIndex = Number(data.pawnIndex);

    if (
      !Number.isInteger(pawnIndex) ||
      pawnIndex < 0 ||
      pawnIndex > 3
    ) {
      return;
    }

    if (game.pendingRolls.length === 0) {
      socket.emit(
        "actionError",
        "Roll the dice first."
      );
      return;
    }

    const roll = game.pendingRolls[0];

    const oldStep = player.pawns[pawnIndex];

    if (oldStep + roll > 24) {
      socket.emit(
        "actionError",
        "That pawn cannot move with this roll."
      );
      return;
    }

    /*
      Lock movement so double taps cannot create
      duplicate moves.
    */
    game.moveLocked = true;

    game.pendingRolls.shift();

    const newStep = oldStep + roll;

    player.pawns[pawnIndex] = newStep;

    const finalCell = player.path[newStep];

    let captured = false;

    if (newStep < 24) {
      captured = performCapture(
        game,
        player,
        finalCell
      );
    }

    const reachedHome = newStep === 24;

    const playerWon = checkPlayerWon(
      game,
      player
    );

    /*
      Tell every browser exactly what happened.
    */
    io.to(game.roomId).emit("moveResult", {
      playerId,
      pawnIndex,
      from: oldStep,
      to: newStep,
      roll,
      captured,
      reachedHome,
      playerWon
    });

    /*
      Small delay allows the clients to animate
      the pawn before the next turn is selected.
    */
    setTimeout(() => {

      if (!rooms.has(game.roomId)) return;

      game.moveLocked = false;

      /*
        HOME or CAPTURE = extra turn.
      */
      const extraTurn =
        reachedHome ||
        captured ||
        roll === 4 ||
        roll === 8;

      /*
        If player has won, skip them.
      */
      if (playerWon) {

        if (game.players.filter(p => !p.hasWon).length <= 1) {

          broadcastState(game);

          io.to(game.roomId).emit(
            "gameFinished",
            {
              winner: player.id
            }
          );

          return;
        }

        nextActivePlayer(game);

      } else if (game.pendingRolls.length > 0) {

        /*
          More pending rolls still need to be used.
        */
        game.canRoll = false;

      } else if (extraTurn) {

        game.canRoll = true;

        io.to(game.roomId).emit(
          "systemMessage",
          `${player.name} gets an extra turn!`
        );

      } else {

        nextActivePlayer(game);
      }

      broadcastState(game);

    }, 180);
  });

  /*
    CHAT
  */

  socket.on("sendChatMessage", data => {

    const game = getGame(socket);

    if (!game) return;

    const player = game.players.find(
      p => p.socketId === socket.id
    );

    if (!player) return;

    const text = String(data?.text || "")
      .trim()
      .substring(0, 200);

    if (!text) return;

    io.to(game.roomId).emit(
      "receiveChatMessage",
      {
        name: player.name,
        text
      }
    );
  });

  /*
    MICROPHONE
    Binary PCM packets are relayed.
  */

  socket.on("voiceData", audioData => {

    const game = getGame(socket);

    if (!game) return;

    if (!audioData) return;

    socket
      .to(game.roomId)
      .emit("voiceData", audioData);
  });

  /*
    DISCONNECT
  */

  socket.on("disconnect", () => {

    console.log(
      "User disconnected:",
      socket.id
    );

    removeSocketFromQueues(socket.id);

    leaveCurrentRoom(socket);
  });
});


server.listen(PORT, "0.0.0.0", () => {

  console.log(
    `Server running on port ${PORT}`
  );
});
