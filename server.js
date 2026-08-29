const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.use(express.static(path.join(__dirname)));

const publicQueues = {
  2: [],
  3: [],
  4: []
};

const rooms = {};

const PATHS = [
  [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],
  [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],
  [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],
  [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
];

const SAFE_CELLS = new Set([
  2, 10, 14, 22, 12
]);

const DICE = [
  1, 1,
  2, 2,
  3, 3,
  4,
  8
];

function newPlayer(id, socketId = null) {
  return {
    id,
    socketId,
    pawns: [0, 0, 0, 0],
    hasKilled: false,
    hasWon: false,
    winRank: 0
  };
}

function makeState(playerIds) {
  return {
    players: playerIds.map(id => newPlayer(id)),
    activePlayerId: playerIds[0],
    awaitingRoll: true,
    pendingRoll: null,
    currentRank: 1,
    version: 1
  };
}

function publicState(room) {
  return {
    players: room.state.players.map(p => ({
      id: p.id,
      pawns: [...p.pawns],
      hasKilled: p.hasKilled,
      hasWon: p.hasWon,
      winRank: p.winRank
    })),

    activePlayerId: room.state.activePlayerId,
    awaitingRoll: room.state.awaitingRoll,
    pendingRoll: room.state.pendingRoll,
    currentRank: room.state.currentRank,
    version: room.state.version
  };
}

function roomForSocket(socket) {
  if (!socket.roomId) return null;
  return rooms[socket.roomId] || null;
}

function leaveQueues(socketId) {
  for (const key of Object.keys(publicQueues)) {
    publicQueues[key] =
      publicQueues[key].filter(s => s.id !== socketId);
  }
}

function generateRoomCode() {
  let code;

  do {
    code =
      Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();
  } while (rooms[code]);

  return code;
}

function setupRoom(roomId, sockets, isPrivate = false) {
  const playerIds =
    sockets.map((_, index) => index);

  const room =
    rooms[roomId] || {
      id: roomId,
      maxPlayers: sockets.length,
      sockets: [],
      isPrivate,
      started: false
    };

  room.sockets = sockets;
  room.started = true;
  room.state = makeState(playerIds);

  rooms[roomId] = room;

  sockets.forEach((sock, index) => {
    sock.roomId = roomId;
    sock.playerIndex = index;

    room.state.players[index].socketId = sock.id;

    sock.join(roomId);

    sock.emit(
      "assignPlayer",
      index
    );
  });

  room.state.version++;

  io.to(roomId).emit("gameStart", {
    playerIds,
    state: publicState(room),

    peers: sockets.map(sock => ({
      playerId: sock.playerIndex,
      socketId: sock.id
    }))
  });

  io.to(roomId).emit(
    "systemMessage",
    "Match started! Blue goes first."
  );
}

function chooseRandomRoll() {
  return DICE[
    Math.floor(Math.random() * DICE.length)
  ];
}

function validMove(player, pawnIndex, roll) {
  if (!Number.isInteger(pawnIndex)) {
    return false;
  }

  if (pawnIndex < 0 || pawnIndex > 3) {
    return false;
  }

  const maxStep =
    player.hasKilled ? 24 : 15;

  return (
    player.pawns[pawnIndex] + roll <= maxStep
  );
}

function hasAnyMove(player, roll) {
  for (let i = 0; i < 4; i++) {
    if (validMove(player, i, roll)) {
      return true;
    }
  }

  return false;
}

function advanceTurn(room) {
  const players =
    room.state.players;

  if (
    players.filter(p => !p.hasWon).length <= 1
  ) {
    room.state.awaitingRoll = false;
    room.state.pendingRoll = null;
    return;
  }

  const currentIndex =
    players.findIndex(
      p => p.id === room.state.activePlayerId
    );

  if (currentIndex < 0) return;

  let next =
    (currentIndex + 1) % players.length;

  let guard = 0;

  while (
    players[next].hasWon &&
    guard < players.length
  ) {
    next =
      (next + 1) % players.length;

    guard++;
  }

  room.state.activePlayerId =
    players[next].id;

  room.state.awaitingRoll = true;
  room.state.pendingRoll = null;
}

function performMove(
  room,
  player,
  pawnIndex
) {
  const roll =
    room.state.pendingRoll;

  const fromStep =
    player.pawns[pawnIndex];

  const toStep =
    fromStep + roll;

  player.pawns[pawnIndex] =
    toStep;

  const finalCell =
    PATHS[player.id][toStep];

  let captured = null;

  if (
    !SAFE_CELLS.has(finalCell) &&
    toStep < 24
  ) {
    outerLoop:

    for (const opponent of room.state.players) {

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
          opponentStep < 24 &&
          PATHS[opponent.id][opponentStep] === finalCell
        ) {
          opponent.pawns[i] = 0;

          captured = {
            playerId: opponent.id,
            pawnIndex: i
          };

          player.hasKilled = true;

          break outerLoop;
        }
      }
    }
  }

  let won = false;

  if (
    toStep === 24 &&
    player.pawns.every(
      step => step === 24
    )
  ) {
    player.hasWon = true;

    player.winRank =
      room.state.currentRank++;

    won = true;
  }

  const extraTurn =
    !won &&
    (
      roll === 4 ||
      roll === 8 ||
      toStep === 24 ||
      captured !== null
    );

  room.state.pendingRoll = null;

  if (won || !extraTurn) {
    advanceTurn(room);
  } else {
    room.state.awaitingRoll = true;
  }

  room.state.version++;

  return {
    playerId: player.id,
    pawnIndex,

    roll,

    fromStep,
    toStep,

    captured,

    extraTurn,

    won,

    state: publicState(room)
  };
}

io.on("connection", socket => {

  console.log(
    "Connected:",
    socket.id
  );

  /*
   * PUBLIC MATCHMAKING
   */

  socket.on(
    "joinGame",
    numPlayers => {

      numPlayers =
        Number(numPlayers);

      if (
        ![2, 3, 4]
          .includes(numPlayers)
      ) {
        return;
      }

      leaveQueues(socket.id);

      publicQueues[numPlayers]
        .push(socket);

      socket.emit(
        "systemMessage",
        `Waiting for ${
          numPlayers -
          publicQueues[numPlayers].length
        } more player(s)...`
      );

      if (
        publicQueues[numPlayers].length >=
        numPlayers
      ) {

        const matched =
          publicQueues[numPlayers]
            .splice(
              0,
              numPlayers
            );

        const roomId =
          "pub_" +
          Math.random()
            .toString(36)
            .substring(2, 8);

        setupRoom(
          roomId,
          matched,
          false
        );
      }
    }
  );

  /*
   * CREATE PRIVATE ROOM
   */

  socket.on(
    "createPrivateGame",
    numPlayers => {

      numPlayers =
        Number(numPlayers);

      if (
        ![2, 3, 4]
          .includes(numPlayers)
      ) {
        return;
      }

      leaveQueues(socket.id);

      const code =
        generateRoomCode();

      rooms[code] = {
        id: code,

        maxPlayers: numPlayers,

        sockets: [socket],

        isPrivate: true,

        started: false,

        state: null
      };

      socket.roomId = code;
      socket.playerIndex = 0;

      socket.join(code);

      socket.emit(
        "privateRoomCreated",
        code
      );

      socket.emit(
        "systemMessage",
        `Room ${code} created. Waiting for players...`
      );
    }
  );

  /*
   * JOIN PRIVATE ROOM
   */

  socket.on(
    "joinPrivateGame",
    rawCode => {

      const code =
        String(rawCode || "")
          .trim()
          .toUpperCase();

      const room =
        rooms[code];

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

      if (
        room.sockets.length >=
        room.maxPlayers
      ) {
        socket.emit(
          "roomError",
          "Room is full!"
        );

        return;
      }

      leaveQueues(socket.id);

      room.sockets.push(socket);

      socket.roomId = code;

      socket.playerIndex =
        room.sockets.length - 1;

      socket.join(code);

      io.to(code).emit(
        "systemMessage",
        `Player joined (${
          room.sockets.length
        }/${room.maxPlayers})...`
      );

      if (
        room.sockets.length ===
        room.maxPlayers
      ) {
        setupRoom(
          code,
          room.sockets,
          true
        );
      }
    }
  );

  /*
   * AUTHORITATIVE ROLL
   */

  socket.on(
    "requestRoll",
    () => {

      const room =
        roomForSocket(socket);

      if (
        !room ||
        !room.started
      ) {
        return;
      }

      const player =
        room.state.players.find(
          p =>
            p.id ===
            socket.playerIndex
        );

      if (!player) {
        return;
      }

      if (
        room.state.activePlayerId !==
        socket.playerIndex
      ) {
        socket.emit(
          "actionError",
          "It is not your turn."
        );

        return;
      }

      if (
        !room.state.awaitingRoll ||
        room.state.pendingRoll !== null
      ) {
        socket.emit(
          "actionError",
          "You cannot roll right now."
        );

        return;
      }

      const roll =
        chooseRandomRoll();

      room.state.pendingRoll =
        roll;

      room.state.awaitingRoll =
        false;

      room.state.version++;

      const possible =
        hasAnyMove(
          player,
          roll
        );

      io.to(room.id).emit(
        "rollApproved",
        {
          playerId: player.id,

          roll,

          possibleMove: possible,

          state: publicState(room)
        }
      );

      /*
       * If no pawn can move,
       * automatically change turn.
       */

      if (!possible) {

        setTimeout(() => {

          const currentRoom =
            rooms[room.id];

          if (
            !currentRoom ||
            !currentRoom.started
          ) {
            return;
          }

          if (
            currentRoom.state.pendingRoll !==
            roll
          ) {
            return;
          }

          if (
            currentRoom.state.activePlayerId !==
            player.id
          ) {
            return;
          }

          currentRoom.state.pendingRoll =
            null;

          advanceTurn(
            currentRoom
          );

          currentRoom.state.version++;

          io.to(
            currentRoom.id
          ).emit(
            "turnSkipped",
            {
              playerId: player.id,
              roll,

              state:
                publicState(
                  currentRoom
                )
            }
          );

        }, 1200);
      }
    }
  );

  /*
   * AUTHORITATIVE MOVE
   */

  socket.on(
    "requestMove",
    data => {

      const room =
        roomForSocket(socket);

      if (
        !room ||
        !room.started
      ) {
        return;
      }

      const player =
        room.state.players.find(
          p =>
            p.id ===
            socket.playerIndex
        );

      const pawnIndex =
        Number(
          data &&
          data.pawnIndex
        );

      if (!player) {
        return;
      }

      if (
        room.state.activePlayerId !==
        player.id
      ) {
        socket.emit(
          "actionError",
          "It is not your turn."
        );

        return;
      }

      if (
        room.state.awaitingRoll ||
        room.state.pendingRoll === null
      ) {
        socket.emit(
          "actionError",
          "Roll the dice first."
        );

        return;
      }

      if (
        !validMove(
          player,
          pawnIndex,
          room.state.pendingRoll
        )
      ) {
        socket.emit(
          "actionError",
          "That pawn cannot make this move."
        );

        return;
      }

      const result =
        performMove(
          room,
          player,
          pawnIndex
        );

      io.to(room.id).emit(
        "moveApproved",
        result
      );

      const remaining =
        room.state.players.filter(
          p => !p.hasWon
        );

      if (
        remaining.length <= 1
      ) {
        io.to(room.id).emit(
          "gameOver",
          {
            winnerId:
              player.id
          }
        );
      }
    }
  );

  /*
   * CHAT
   */

  socket.on(
    "sendChatMessage",
    data => {

      const room =
        roomForSocket(socket);

      if (!room) return;

      const name =
        String(
          data?.name ||
          "Player"
        ).slice(0, 30);

      const text =
        String(
          data?.text ||
          ""
        ).slice(0, 250);

      if (!text.trim()) {
        return;
      }

      io.to(room.id).emit(
        "receiveChatMessage",
        {
          name,
          text
        }
      );
    }
  );

  /*
   * WEBRTC VOICE SIGNALING
   */

  socket.on(
    "voiceOffer",
    data => {

      const room =
        roomForSocket(socket);

      if (
        !room ||
        !data?.to
      ) {
        return;
      }

      io.to(data.to).emit(
        "voiceOffer",
        {
          from: socket.id,
          offer: data.offer
        }
      );
    }
  );

  socket.on(
    "voiceAnswer",
    data => {

      const room =
        roomForSocket(socket);

      if (
        !room ||
        !data?.to
      ) {
        return;
      }

      io.to(data.to).emit(
        "voiceAnswer",
        {
          from: socket.id,
          answer: data.answer
        }
      );
    }
  );

  socket.on(
    "voiceIceCandidate",
    data => {

      const room =
        roomForSocket(socket);

      if (
        !room ||
        !data?.to
      ) {
        return;
      }

      io.to(data.to).emit(
        "voiceIceCandidate",
        {
          from: socket.id,
          candidate:
            data.candidate
        }
      );
    }
  );

  /*
   * DISCONNECT
   */

  socket.on(
    "disconnect",
    () => {

      leaveQueues(
        socket.id
      );

      const room =
        socket.roomId
          ? rooms[socket.roomId]
          : null;

      if (room) {

        io.to(room.id).emit(
          "voicePeerLeft",
          {
            socketId:
              socket.id
          }
        );

        if (room.started) {

          io.to(room.id).emit(
            "roomClosed",
            "A player disconnected. The match was closed. Please start a new match."
          );

          room.sockets.forEach(
            otherSocket => {
              try {
                otherSocket.leave(
                  room.id
                );

                otherSocket.roomId =
                  null;
              } catch {}
            }
          );

          delete rooms[
            room.id
          ];

        } else {

          room.sockets =
            room.sockets.filter(
              s =>
                s.id !== socket.id
            );

          if (
            room.sockets.length === 0
          ) {
            delete rooms[
              room.id
            ];
          }
        }
      }

      console.log(
        "Disconnected:",
        socket.id
      );
    }
  );
});

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  () => {
    console.log(
      `Ludo Twist server running on port ${PORT}`
    );
  }
);
