const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  transports: ["websocket", "polling"]
});

app.use(express.static(path.join(__dirname)));

const publicQueues = {
  2: [],
  3: [],
  4: []
};

const rooms = {};

const COLORS = [
  { id: 0, name: "Blue", color: "#1e90ff" },
  { id: 1, name: "Red", color: "#ff4757" },
  { id: 2, name: "Green", color: "#2ed573" },
  { id: 3, name: "Yellow", color: "#ffa502" }
];

const PATHS = [
  [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],
  [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],
  [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],
  [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
];

const SAFE = new Set([2, 10, 14, 22, 12]);

function makePlayer(id) {
  return {
    id,
    name: COLORS[id].name,
    color: COLORS[id].color,
    pawns: [0, 0, 0, 0],
    hasKilled: false,
    hasWon: false,
    winRank: 0
  };
}

function makeGame(playerIds) {
  return {
    playerIds,
    players: playerIds.map(makePlayer),
    activeIndex: 0,
    rolls: [],
    canRoll: true,
    busy: false,
    rank: 1,
    started: true
  };
}

function publicState(room) {
  const g = room.game;

  return {
    activeIndex: g.activeIndex,
    activePlayerId: g.playerIds[g.activeIndex],
    rolls: [...g.rolls],
    canRoll: g.canRoll,
    busy: g.busy,
    rank: g.rank,
    players: g.players.map(p => ({
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

function emitState(roomId) {
  const room = rooms[roomId];
  if (!room || !room.game) return;

  io.to(roomId).emit("gameState", publicState(room));
}

function findRoom(socket) {
  return socket.roomId ? rooms[socket.roomId] : null;
}

function removeFromQueues(socketId) {
  for (const key of Object.keys(publicQueues)) {
    publicQueues[key] =
      publicQueues[key].filter(s => s.id !== socketId);
  }
}

function nextPlayer(game) {
  let tries = 0;

  do {
    game.activeIndex =
      (game.activeIndex + 1) % game.playerIds.length;

    tries++;
  } while (
    game.players[game.activeIndex].hasWon &&
    tries <= game.playerIds.length
  );

  game.rolls = [];
  game.canRoll = true;
  game.busy = false;
}

function validMove(player, pawnIndex, roll) {
  const step = player.pawns[pawnIndex];

  if (step >= 24) return false;

  /*
    Original rule:
    Before player has killed, maximum movement is 15.
    After killing, movement can continue to 24.
  */
  const maximum = player.hasKilled ? 24 : 15;

  return step + roll <= maximum;
}

function anyValidMove(player, roll) {
  return player.pawns.some((_, index) =>
    validMove(player, index, roll)
  );
}

function advanceAfterNoMove(roomId) {
  const room = rooms[roomId];
  if (!room || !room.game) return;

  const game = room.game;

  if (game.busy) return;

  if (game.rolls.length === 0 && !game.canRoll) {
    nextPlayer(game);
    emitState(roomId);

    const p = game.players[game.activeIndex];

    io.to(roomId).emit(
      "turnMessage",
      `${p.name}'s turn.`
    );
  }
}

function finishMove(roomId, playerId, pawnIndex, roll) {
  const room = rooms[roomId];

  if (!room || !room.game) return;

  const game = room.game;

  const player = game.players.find(
    p => p.id === playerId
  );

  if (!player) return;

  let pawnStep = player.pawns[pawnIndex];

  /*
    Move pawn one square at a time.
  */
  const steps = Math.min(roll, 24 - pawnStep);

  io.to(roomId).emit("pawnMoveStart", {
    playerId,
    pawnIndex,
    fromStep: pawnStep,
    steps
  });

  setTimeout(() => {
    if (!rooms[roomId]) return;

    player.pawns[pawnIndex] += steps;

    const finalCell =
      PATHS[playerId][player.pawns[pawnIndex]];

    let extraTurn = false;

    /*
      Pawn reached HOME.
    */
    if (player.pawns[pawnIndex] === 24) {
      extraTurn = true;

      if (player.pawns.every(p => p === 24)) {
        player.hasWon = true;
        player.winRank = game.rank++;
      }
    }

    /*
      Capture.
    */
    if (!SAFE.has(finalCell)) {
      for (const opponent of game.players) {
        if (opponent.id === player.id || opponent.hasWon) {
          continue;
        }

        for (let i = 0; i < opponent.pawns.length; i++) {
          if (
            opponent.pawns[i] < 24 &&
            PATHS[opponent.id][opponent.pawns[i]] === finalCell
          ) {
            opponent.pawns[i] = 0;
            player.hasKilled = true;
            extraTurn = true;

            io.to(roomId).emit("capture", {
              attackerId: player.id,
              victimId: opponent.id,
              victimPawn: i
            });
          }
        }
      }
    }

    game.rolls.shift();

    /*
      4 / 8 already gives another roll.
      Capture/home also gives another roll.
    */
    if (extraTurn) {
      game.canRoll = true;
    }

    if (player.hasWon) {
      game.rolls = [];
      game.canRoll = false;

      io.to(roomId).emit(
        "turnMessage",
        `${player.name} finished in position ${player.winRank}!`
      );

      setTimeout(() => {
        if (!rooms[roomId]) return;

        nextPlayer(game);
        emitState(roomId);
      }, 1200);

      return;
    }

    if (game.rolls.length === 0 && !game.canRoll) {
      nextPlayer(game);
    }

    game.busy = false;

    emitState(roomId);

    if (extraTurn) {
      io.to(roomId).emit(
        "turnMessage",
        `${player.name} gets an extra turn!`
      );
    }
  }, steps * 170 + 250);
}

function setupRoom(roomId, sockets) {
  const ids = [0, 1, 2, 3].slice(0, sockets.length);

  const room = rooms[roomId] || {
    maxPlayers: sockets.length,
    sockets: [],
    started: false,
    isPrivate: false
  };

  room.sockets = sockets;
  room.started = true;
  room.game = makeGame(ids);

  rooms[roomId] = room;

  sockets.forEach((sock, index) => {
    sock.roomId = roomId;
    sock.playerIndex = ids[index];

    sock.join(roomId);

    sock.emit("assignPlayer", ids[index]);
  });

  io.to(roomId).emit("gameStart", ids);

  emitState(roomId);

  io.to(roomId).emit(
    "turnMessage",
    "Match started! Blue goes first."
  );
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("joinGame", numPlayers => {
    removeFromQueues(socket.id);

    if (![2, 3, 4].includes(numPlayers)) return;

    publicQueues[numPlayers].push(socket);

    if (publicQueues[numPlayers].length >= numPlayers) {
      const players =
        publicQueues[numPlayers].splice(0, numPlayers);

      const roomId =
        "pub_" +
        Math.random().toString(36).substring(2, 8);

      rooms[roomId] = {
        maxPlayers: numPlayers,
        sockets: players,
        started: false,
        isPrivate: false
      };

      setupRoom(roomId, players);
    } else {
      socket.emit(
        "systemMessage",
        `Waiting for ${numPlayers -
          publicQueues[numPlayers].length} more players...`
      );
    }
  });

  socket.on("createPrivateGame", numPlayers => {
    removeFromQueues(socket.id);

    const code =
      Math.random().toString(36).substring(2, 8).toUpperCase();

    rooms[code] = {
      maxPlayers: numPlayers,
      sockets: [socket],
      started: false,
      isPrivate: true
    };

    socket.roomId = code;
    socket.join(code);

    socket.emit("privateRoomCreated", code);
    socket.emit(
      "systemMessage",
      `Room created: ${code}`
    );
  });

  socket.on("joinPrivateGame", code => {
    code = String(code || "").trim().toUpperCase();

    const room = rooms[code];

    if (!room) {
      socket.emit("roomError", "Room code not found.");
      return;
    }

    if (room.started) {
      socket.emit("roomError", "Game already started.");
      return;
    }

    if (room.sockets.length >= room.maxPlayers) {
      socket.emit("roomError", "Room is full.");
      return;
    }

    removeFromQueues(socket.id);

    room.sockets.push(socket);

    socket.roomId = code;
    socket.join(code);

    io.to(code).emit(
      "systemMessage",
      `Player joined (${room.sockets.length}/${room.maxPlayers})`
    );

    if (room.sockets.length === room.maxPlayers) {
      setupRoom(code, room.sockets);
    }
  });

  /*
    SERVER-AUTHORITATIVE ROLL
  */
  socket.on("requestRoll", () => {
    const room = findRoom(socket);

    if (!room || !room.game) return;

    const game = room.game;

    if (game.busy || !game.canRoll) return;

    const currentId =
      game.playerIds[game.activeIndex];

    if (socket.playerIndex !== currentId) {
      socket.emit("actionRejected", "It is not your turn.");
      return;
    }

    const roll =
      [1,1,2,2,3,3,4,8][
        Math.floor(Math.random() * 8)
      ];

    game.canRoll =
      roll === 4 || roll === 8;

    game.rolls.push(roll);

    const player =
      game.players[game.activeIndex];

    /*
      If no pawn can use the roll:
      normal roll -> turn ends
      4/8 -> player keeps the extra roll
    */
    if (!anyValidMove(player, roll)) {
      game.rolls.shift();

      if (!game.canRoll) {
        nextPlayer(game);
      }

      emitState(room.roomId);

      return;
    }

    emitState(room.roomId);

    io.to(room.roomId).emit("diceRolled", {
      playerId: currentId,
      value: roll
    });
  });

  /*
    SERVER-AUTHORITATIVE MOVE
  */
  socket.on("requestMove", data => {
    const room = findRoom(socket);

    if (!room || !room.game) return;

    const game = room.game;

    if (game.busy) return;

    const playerId = Number(data.playerId);
    const pawnIndex = Number(data.pawnIndex);

    if (socket.playerIndex !== playerId) {
      socket.emit(
        "actionRejected",
        "You cannot move another player's pawn."
      );
      return;
    }

    if (
      playerId !==
      game.playerIds[game.activeIndex]
    ) {
      socket.emit(
        "actionRejected",
        "It is not your turn."
      );
      return;
    }

    if (
      !Number.isInteger(pawnIndex) ||
      pawnIndex < 0 ||
      pawnIndex > 3
    ) return;

    if (game.rolls.length === 0) return;

    const roll = game.rolls[0];

    const player =
      game.players.find(p => p.id === playerId);

    if (!player) return;

    if (!validMove(player, pawnIndex, roll)) {
      socket.emit(
        "actionRejected",
        "That pawn cannot move that far."
      );
      return;
    }

    game.busy = true;

    finishMove(
      room.roomId,
      playerId,
      pawnIndex,
      roll
    );
  });

  /*
    CHAT
  */
  socket.on("sendChatMessage", data => {
    const room = findRoom(socket);

    if (!room) return;

    const name =
      COLORS[socket.playerIndex]?.name ||
      "Player";

    const text =
      String(data?.text || "").trim().substring(0, 200);

    if (!text) return;

    io.to(socket.roomId).emit(
      "receiveChatMessage",
      {
        name,
        text
      }
    );
  });

  /*
    WebRTC microphone signalling.
  */
  socket.on("rtc-offer", data => {
    const room = findRoom(socket);

    if (!room) return;

    const target = room.sockets.find(
      s => s.playerIndex === Number(data.to)
    );

    if (target) {
      target.emit("rtc-offer", {
        from: socket.playerIndex,
        offer: data.offer
      });
    }
  });

  socket.on("rtc-answer", data => {
    const room = findRoom(socket);

    if (!room) return;

    const target = room.sockets.find(
      s => s.playerIndex === Number(data.to)
    );

    if (target) {
      target.emit("rtc-answer", {
        from: socket.playerIndex,
        answer: data.answer
      });
    }
  });

  socket.on("rtc-ice", data => {
    const room = findRoom(socket);

    if (!room) return;

    const target = room.sockets.find(
      s => s.playerIndex === Number(data.to)
    );

    if (target) {
      target.emit("rtc-ice", {
        from: socket.playerIndex,
        candidate: data.candidate
      });
    }
  });

  socket.on("disconnect", () => {
    removeFromQueues(socket.id);

    const roomId = socket.roomId;
    const room = roomId ? rooms[roomId] : null;

    if (room) {
      room.sockets =
        room.sockets.filter(
          s => s.id !== socket.id
        );

      io.to(roomId).emit(
        "systemMessage",
        "A player disconnected."
      );

      if (room.game) {
        io.to(roomId).emit(
          "playerDisconnected",
          socket.playerIndex
        );
      }

      if (room.sockets.length === 0) {
        delete rooms[roomId];
      }
    }

    console.log("Disconnected:", socket.id);
  });
});

const PORT =
  process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Ludo Twist server running on port ${PORT}`
  );
});
