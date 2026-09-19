const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const COLORS = [
  "#2397ff",
  "#ff5969",
  "#35d97f",
  "#ffad16"
];

const NAMES = [
  "Blue",
  "Red",
  "Green",
  "Yellow"
];

const PATHS = [
  [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],

  [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],

  [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],

  [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
];

const SAFE = [2,10,12,14,22];

const DICE_VALUES = [
  1,1,2,2,3,3,4,8
];

const HOME = 24;


/* =========================================================
   PUBLIC QUEUES
========================================================= */

const queues = {
  2: [],
  3: [],
  4: []
};


/* =========================================================
   ROOMS
========================================================= */

const rooms = new Map();


/* =========================================================
   PLAYER
========================================================= */

function makePlayer(socketId, index) {

  return {
    id: socketId,

    index,

    name: NAMES[index],

    color: COLORS[index],

    pawns: [0,0,0,0],

    hasKilled: false,

    finished: false,

    rank: 0,

    lastRoll: null
  };
}


/* =========================================================
   ROOM
========================================================= */

function makeRoom(
  id,
  mode,
  maxPlayers,
  code = null
) {

  return {

    id,

    mode,

    code,

    maxPlayers,

    players: [],

    started: false,

    currentIndex: 0,

    rank: 1,

    pendingRolls: new Map(),

    canRoll: false,

    turnVersion: 0,

    timers: new Set()

  };
}


/* =========================================================
   VALIDATION
========================================================= */

function isValidMove(
  player,
  pawnIndex,
  roll
) {

  if (!player) return false;

  pawnIndex = Number(pawnIndex);
  roll = Number(roll);

  if (
    !Number.isInteger(pawnIndex) ||
    pawnIndex < 0 ||
    pawnIndex > 3
  ) {
    return false;
  }

  if (
    !Number.isInteger(roll) ||
    roll < 1
  ) {
    return false;
  }

  const step =
    Number(player.pawns[pawnIndex]);

  if (step >= HOME) {
    return false;
  }

  const maximum =
    player.hasKilled
      ? HOME
      : 15;

  return (
    step + roll <= maximum
  );
}


/* =========================================================
   CAPTURE (Captures only one pawn on the cell)
========================================================= */

function performCapture(
  room,
  player,
  toStep
) {

  if (toStep >= HOME) {
    return false;
  }

  const cell =
    PATHS[player.index][toStep];

  if (SAFE.includes(cell)) {
    return false;
  }

  let captured = false;

  for (const opponent of room.players) {

    if (
      opponent.index === player.index
    ) {
      continue;
    }

    for (
      let i = 0;
      i < opponent.pawns.length;
      i++
    ) {

      const opponentStep =
        Number(opponent.pawns[i]);

      if (
        opponentStep < HOME &&
        PATHS[opponent.index][opponentStep] === cell
      ) {

        opponent.pawns[i] = 0;

        captured = true;
        break; // Stop after capturing one pawn on this cell
      }
    }

    if (captured) {
      break; // Stop checking other opponents once a capture is made
    }
  }

  if (captured) {
    player.hasKilled = true;
  }

  return captured;
}


/* =========================================================
   PUBLIC STATE
========================================================= */

function getPublicState(
  room,
  forSocketId = null
) {

  const currentPlayer =
    room.players[room.currentIndex];

  const ownPending =
    forSocketId &&
    room.pendingRolls.has(forSocketId)
      ? room.pendingRolls.get(forSocketId)
      : [];

  const currentCanRoll =
    currentPlayer &&
    forSocketId === currentPlayer.id
      ? room.canRoll
      : false;

  return {

    roomId: room.id,

    mode: room.mode,

    code: room.code,

    maxPlayers: room.maxPlayers,

    playerCount: room.players.length,

    started: room.started,

    currentIndex: room.currentIndex,

    active: room.currentIndex,

    canRoll: currentCanRoll,

    rank: room.rank,

    players: room.players.map(player => ({

      id: player.id,

      index: player.index,

      name: player.name,

      color: player.color,

      pawns: [...player.pawns],

      hasKilled: player.hasKilled,

      finished: player.finished,

      hasWon: player.finished,

      rank: player.rank,

      lastRoll: player.lastRoll

    })),

    pendingRolls:
      ownPending.map(roll => ({
        rollId: roll.rollId,
        value: roll.value,
        extraAvailable: roll.extraAvailable
      }))

  };
}


function sendState(room) {

  if (!room) return;

  for (const player of room.players) {

    io.to(player.id).emit(
      "gameState",
      getPublicState(
        room,
        player.id
      )
    );
  }
}


/* =========================================================
   SYSTEM MESSAGE
========================================================= */

function sendSystemMessage(
  room,
  message
) {

  if (!room) return;

  io.to(room.id).emit(
    "systemMessage",
    message
  );
}


/* =========================================================
   ROOM LOOKUP
========================================================= */

function findRoomByPlayer(socketId) {

  for (const room of rooms.values()) {

    if (
      room.players.some(
        p => p.id === socketId
      )
    ) {

      return room;
    }
  }

  return null;
}


/* =========================================================
   QUEUE MANAGEMENT
========================================================= */

function leaveQueue(socketId) {

  for (const count of [2,3,4]) {

    queues[count] =
      queues[count].filter(
        id => id !== socketId
      );
  }
}


function cleanQueues() {

  for (const count of [2,3,4]) {

    queues[count] =
      queues[count].filter(
        socketId =>
          io.sockets.sockets.has(socketId)
      );
  }
}


function addToQueue(
  socketId,
  numberOfPlayers
) {

  leaveQueue(socketId);

  if (
    !queues[numberOfPlayers].includes(socketId)
  ) {

    queues[numberOfPlayers].push(
      socketId
    );
  }
}


/* =========================================================
   REMOVE ROOM
========================================================= */

function closeRoom(
  room,
  message
) {

  if (!room) return;

  room.started = false;

  for (const timer of room.timers) {
    clearTimeout(timer);
  }

  room.timers.clear();

  for (const player of room.players) {

    const playerSocket =
      io.sockets.sockets.get(
        player.id
      );

    if (playerSocket) {

      playerSocket.leave(
        room.id
      );
    }
  }

  io.to(room.id).emit(
    "roomClosed",
    message || "The room was closed."
  );

  rooms.delete(room.id);
}


function removeSocketFromRoom(socketId) {

  const room =
    findRoomByPlayer(socketId);

  if (!room) {
    return false;
  }

  closeRoom(
    room,
    "A player left the game. The room was closed."
  );

  return true;
}


/* =========================================================
   START ROOM
========================================================= */

function startRoom(room) {

  if (!room) return;

  if (
    room.players.length !==
    room.maxPlayers
  ) {
    return;
  }

  if (room.started) {
    return;
  }

  room.started = true;

  room.currentIndex = 0;

  room.rank = 1;

  room.canRoll = true;

  room.turnVersion++;

  room.pendingRolls.clear();

  for (const player of room.players) {

    player.pawns =
      [0,0,0,0];

    player.hasKilled = false;

    player.finished = false;

    player.rank = 0;

    player.lastRoll = null;
  }

  io.to(room.id).emit(
    "gameStart",
    getPublicState(room)
  );

  sendState(room);

  sendSystemMessage(
    room,
    `${room.players[0].name} goes first.`
  );
}


/* =========================================================
   PUBLIC MULTIPLAYER
========================================================= */

function joinPublicGame(
  socket,
  numberOfPlayers
) {

  numberOfPlayers =
    Number(numberOfPlayers);

  if (
    ![2,3,4].includes(
      numberOfPlayers
    )
  ) {

    socket.emit(
      "roomError",
      "Player count must be 2, 3, or 4."
    );

    return;
  }

  leaveQueue(socket.id);

  const oldRoom =
    findRoomByPlayer(socket.id);

  if (oldRoom) {

    closeRoom(
      oldRoom,
      "The room was closed because a player joined another game."
    );
  }

  cleanQueues();

  addToQueue(
    socket.id,
    numberOfPlayers
  );

  socket.emit(
    "waiting",
    `Waiting for ${numberOfPlayers} players...`
  );

  queues[numberOfPlayers] =
    queues[numberOfPlayers].filter(
      socketId =>
        io.sockets.sockets.has(socketId)
    );

  if (
    queues[numberOfPlayers].length <
    numberOfPlayers
  ) {

    return;
  }

  const selected =
    queues[numberOfPlayers].splice(
      0,
      numberOfPlayers
    );

  const roomId =
    `public_${numberOfPlayers}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2,10)}`;

  const room =
    makeRoom(
      roomId,
      "public",
      numberOfPlayers,
      null
    );

  rooms.set(
    room.id,
    room
  );

  for (
    let index = 0;
    index < selected.length;
    index++
  ) {

    const socketId =
      selected[index];

    const playerSocket =
      io.sockets.sockets.get(
        socketId
      );

    if (!playerSocket) {
      continue;
    }

    const existingRoom =
      findRoomByPlayer(socketId);

    if (existingRoom) {

      closeRoom(
        existingRoom,
        "The old room was closed."
      );
    }

    const player =
      makePlayer(
        socketId,
        index
      );

    room.players.push(
      player
    );

    playerSocket.join(
      room.id
    );

    playerSocket.emit(
      "assignPlayer",
      {
        playerId: socketId,

        index,

        name: player.name,

        playerName: player.name,

        color: player.color,

        roomId: room.id,

        mode: "public",

        maxPlayers: numberOfPlayers
      }
    );
  }

  if (
    room.players.length !==
    room.maxPlayers
  ) {

    closeRoom(
      room,
      "Not enough players were available. Please try again."
    );

    for (const player of room.players) {

      if (
        io.sockets.sockets.has(
          player.id
        )
      ) {

        addToQueue(
          player.id,
          numberOfPlayers
        );

        io.to(player.id).emit(
          "waiting",
          `Waiting for ${numberOfPlayers} players...`
        );
      }
    }

    return;
  }

  startRoom(room);
}


/* =========================================================
   PRIVATE ROOM CODE
========================================================= */

function makeRoomCode() {

  let code;

  do {

    code =
      Math.random()
        .toString(36)
        .substring(2,8)
        .toUpperCase();

  } while (
    [...rooms.values()]
      .some(
        room =>
          room.mode === "private" &&
          room.code === code
      )
  );

  return code;
}


function findPrivateRoom(code) {

  const normalized =
    String(code || "")
      .trim()
      .toUpperCase();

  if (!normalized) {
    return null;
  }

  for (const room of rooms.values()) {

    if (
      room.mode === "private" &&
      room.code === normalized
    ) {

      return room;
    }
  }

  return null;
}


function createPrivateGame(
  socket,
  numberOfPlayers
) {

  numberOfPlayers =
    Number(numberOfPlayers);

  if (
    ![2,3,4].includes(
      numberOfPlayers
    )
  ) {

    socket.emit(
      "roomError",
      "Player count must be 2, 3, or 4."
    );

    return;
  }

  leaveQueue(socket.id);

  const oldRoom =
    findRoomByPlayer(socket.id);

  if (oldRoom) {

    closeRoom(
      oldRoom,
      "The old room was closed."
    );
  }

  const code =
    makeRoomCode();

  const roomId =
    `private_${code}`;

  const room =
    makeRoom(
      roomId,
      "private",
      numberOfPlayers,
      code
    );

  rooms.set(
    room.id,
    room
  );

  const player =
    makePlayer(
      socket.id,
      0
    );

  room.players.push(
    player
  );

  socket.join(
    room.id
  );

  socket.emit(
    "assignPlayer",
    {
      playerId: socket.id,

      index: 0,

      name: player.name,

      playerName: player.name,

      color: player.color,

      roomId: room.id,

      mode: "private",

      code,

      roomCode: code,

      maxPlayers: numberOfPlayers
    }
  );

  socket.emit(
    "privateRoomCreated",
    {
      code,

      roomCode: code,

      players: 1,

      playerCount: 1,

      maxPlayers: numberOfPlayers,

      roomId: room.id
    }
  );

  sendState(room);
}


function joinPrivateGame(
  socket,
  rawCode
) {

  const code =
    String(rawCode || "")
      .trim()
      .toUpperCase();

  if (!code) {

    socket.emit(
      "roomError",
      "Please enter a room code."
    );

    return;
  }

  const room =
    findPrivateRoom(code);

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
    room.players.length >=
    room.maxPlayers
  ) {

    socket.emit(
      "roomError",
      "Room is full!"
    );

    return;
  }

  leaveQueue(socket.id);

  const oldRoom =
    findRoomByPlayer(socket.id);

  if (
    oldRoom &&
    oldRoom !== room
  ) {

    closeRoom(
      oldRoom,
      "The old room was closed."
    );
  }

  const alreadyInside =
    room.players.find(
      p => p.id === socket.id
    );

  if (alreadyInside) {

    socket.join(
      room.id
    );

    socket.emit(
      "assignPlayer",
      {
        playerId: alreadyInside.id,

        index: alreadyInside.index,

        name: alreadyInside.name,

        playerName: alreadyInside.name,

        color: alreadyInside.color,

        roomId: room.id,

        mode: "private",

        code: room.code,

        roomCode: room.code,

        maxPlayers: room.maxPlayers
      }
    );

    sendState(room);

    return;
  }

  const usedIndexes =
    new Set(
      room.players.map(
        p => p.index
      )
    );

  let index = -1;

  for (
    let i = 0;
    i < room.maxPlayers;
    i++
  ) {

    if (
      !usedIndexes.has(i)
    ) {

      index = i;

      break;
    }
  }

  if (index < 0) {

    socket.emit(
      "roomError",
      "Room is full!"
    );

    return;
  }

  const player =
    makePlayer(
      socket.id,
      index
    );

  room.players.push(
    player
  );

  socket.join(
    room.id
  );

  socket.emit(
    "assignPlayer",
    {
      playerId: socket.id,

      index,

      name: player.name,

      playerName: player.name,

      color: player.color,

      roomId: room.id,

      mode: "private",

      code: room.code,

      roomCode: room.code,

      maxPlayers: room.maxPlayers
    }
  );

  sendSystemMessage(
    room,
    `${player.name} joined the room.`
  );

  sendState(room);

  if (
    room.players.length ===
    room.maxPlayers
  ) {

    startRoom(room);
  }
}


/* =========================================================
   TURN MANAGEMENT
========================================================= */

function getCurrentPlayer(room) {

  return room.players[
    room.currentIndex
  ];
}


function getPendingRolls(
  room,
  socketId
) {

  if (
    !room.pendingRolls.has(
      socketId
    )
  ) {

    room.pendingRolls.set(
      socketId,
      []
    );
  }

  return room.pendingRolls.get(
    socketId
  );
}


function clearPendingRolls(
  room,
  socketId
) {

  room.pendingRolls.delete(
    socketId
  );
}


function schedule(
  room,
  fn,
  delay
) {

  const timer =
    setTimeout(
      ()=>{
        room.timers.delete(timer);
        fn();
      },
      delay
    );

  room.timers.add(timer);
}


function nextTurn(room) {

  if (!room.started) return;

  const count =
    room.players.length;

  for (
    let i=1;
    i<=count;
    i++
  ) {

    const next =
      (room.currentIndex+i)%count;

    const player =
      room.players[next];

    if (
      player &&
      !player.finished
    ) {

      room.currentIndex =
        next;

      room.canRoll =
        true;

      room.pendingRolls.clear();

      room.turnVersion++;

      sendState(room);

      sendSystemMessage(
        room,
        `${player.name}'s turn`
      );

      return;
    }
  }
}


/* =========================================================
   REQUEST ROLL
========================================================= */

function handleRequestRoll(
  socket,
  room
) {

  if (!room || !room.started) {
    return;
  }

  const player =
    room.players.find(
      p=>p.id===socket.id
    );

  if (!player) {
    return;
  }

  if (
    room.currentIndex !==
    player.index
  ) {

    socket.emit(
      "actionError",
      "It is not your turn."
    );

    return;
  }

  if (!room.canRoll) {

    socket.emit(
      "actionError",
      "Roll is not available yet."
    );

    return;
  }

  const pending =
    getPendingRolls(
      room,
      socket.id
    );

  const value =
    DICE_VALUES[
      Math.floor(
        Math.random()*
        DICE_VALUES.length
      )
    ];

  const rollId =
    `${Date.now()}_${Math.random()
      .toString(36)
      .slice(2,8)}`;

  const roll = {

    rollId,

    value,

    extraAvailable:
      value===4 ||
      value===8
  };

  pending.push(
    roll
  );

  player.lastRoll =
    value;

  room.canRoll =
    value===4 ||
    value===8;

  io.to(room.id).emit(
    "diceRolled",
    {
      playerId:player.id,

      playerIndex:player.index,

      value,

      rollId,

      extraAvailable:
        roll.extraAvailable
    }
  );

  sendState(room);

  const validMoves = [];

  for (
    let i=0;
    i<4;
    i++
  ) {

    if (
      isValidMove(
        player,
        i,
        value
      )
    ) {

      validMoves.push(i);
    }
  }

  if (
    validMoves.length > 0
  ) {

    return;
  }

  const rollIndex =
    pending.findIndex(
      r=>r.rollId===rollId
    );

  if (
    rollIndex >= 0
  ) {

    pending.splice(
      rollIndex,
      1
    );
  }

  if (
    value===4 ||
    value===8
  ) {

    room.canRoll =
      true;

    sendState(room);

    sendSystemMessage(
      room,
      `${player.name} gets another roll.`
    );

    return;
  }

  room.canRoll =
    false;

  sendState(room);

  sendSystemMessage(
    room,
    `${player.name} has no valid move.`
  );

  const version =
    room.turnVersion;

  schedule(
    room,
    ()=>{
      if (
        !room.started ||
        room.turnVersion!==version
      ) {
        return;
      }

      nextTurn(room);
    },
    800
  );
}


/* =========================================================
   REQUEST MOVE
========================================================= */

function handleRequestMove(
  socket,
  room,
  data
) {

  if (!room || !room.started) {
    return;
  }

  const player =
    room.players.find(
      p=>p.id===socket.id
    );

  if (!player) {
    return;
  }

  if (
    room.currentIndex !==
    player.index
  ) {

    socket.emit(
      "actionError",
      "It is not your turn."
    );

    return;
  }

  const pawnIndex =
    Number(
      data &&
      data.pawnIndex
    );

  if (
    !Number.isInteger(
      pawnIndex
    ) ||
    pawnIndex<0 ||
    pawnIndex>3
  ) {

    socket.emit(
      "actionError",
      "Choose a valid pawn."
    );

    return;
  }

  const rollId =
    String(
      data &&
      data.rollId ||
      ""
    );

  const pending =
    getPendingRolls(
      room,
      socket.id
    );

  let rollIndex =
    pending.findIndex(
      r=>r.rollId===rollId
    );

  if (
    rollIndex<0 &&
    pending.length===1
  ) {

    rollIndex=0;
  }

  if (
    rollIndex<0
  ) {

    socket.emit(
      "actionError",
      "Choose a dice number first."
    );

    return;
  }

  const rollObject =
    pending[rollIndex];

  const roll =
    Number(
      rollObject.value
    );

  if (
    !isValidMove(
      player,
      pawnIndex,
      roll
    )
  ) {

    socket.emit(
      "actionError",
      "That pawn cannot move with this dice."
    );

    return;
  }

  pending.splice(
    rollIndex,
    1
  );

  const oldStep =
    Number(
      player.pawns[pawnIndex]
    );

  let newStep =
    oldStep+roll;

  if (
    newStep>HOME
  ) {

    newStep=HOME;
  }

  player.pawns[pawnIndex] =
    newStep;

  const captured =
    performCapture(
      room,
      player,
      newStep
    );

  const reachedHome =
    newStep>=HOME;

  if (
    reachedHome
  ) {

    player.pawns[pawnIndex] =
      HOME;
  }

  const completed =
    player.pawns.every(
      pawn=>pawn>=HOME
    );

  if (
    completed
  ) {

    player.finished =
      true;

    player.rank =
      room.rank++;

    room.canRoll =
      false;

    room.pendingRolls.clear();

    io.to(room.id).emit(
      "moveResult",
      {
        playerId:player.id,

        playerIndex:player.index,

        pawnIndex,

        from:oldStep,

        to:player.pawns[pawnIndex],

        oldStep,

        newStep:player.pawns[pawnIndex],

        roll,

        captured,

        reachedHome,

        extra:false
      }
    );

    io.to(room.id).emit(
      "playerFinished",
      {
        playerId:player.id,

        playerIndex:player.index,

        name:player.name,

        rank:player.rank
      }
    );

    const unfinished =
      room.players.filter(
        p=>!p.finished
      );

    sendState(room);

    if (
      unfinished.length<=1
    ) {

      if (
        unfinished.length===1
      ) {

        const last =
          unfinished[0];

        last.finished =
          true;

        last.rank =
          room.rank++;

        io.to(room.id).emit(
          "playerFinished",
          {
            playerId:last.id,

            playerIndex:last.index,

            name:last.name,

            rank:last.rank
          }
        );
      }

      room.started =
        false;

      sendState(room);

      io.to(room.id).emit(
        "gameFinished",
        {
          message:
            `${player.name} finished the game!`
        }
      );

      return;
    }

    const version =
      ++room.turnVersion;

    room.pendingRolls.clear();

    schedule(
      room,
      ()=>{
        if (
          !room.started ||
          room.turnVersion!==version
        ) {
          return;
        }

        nextTurn(room);
      },
      850
    );

    return;
  }

  const extra =
    roll===4 ||
    roll===8 ||
    captured ||
    reachedHome;

  io.to(room.id).emit(
    "moveResult",
    {
      playerId:player.id,

      playerIndex:player.index,

      pawnIndex,

      from:oldStep,

      to:player.pawns[pawnIndex],

      oldStep,

      newStep:player.pawns[pawnIndex],

      roll,

      captured,

      reachedHome,

      extra
    }
  );

  if (
    extra
  ) {

    room.canRoll =
      true;

  } else if (
    pending.length>0
  ) {

    room.canRoll =
      false;

  } else {

    room.canRoll =
      false;
  }

  sendState(room);

  if (
    extra
  ) {

    sendSystemMessage(
      room,
      captured
        ? `${player.name} captured a pawn! Roll again.`
        : reachedHome
          ? `${player.name} reached HOME! Roll again.`
          : `${player.name} gets another roll.`
    );

    return;
  }

  if (
    pending.length>0
  ) {

    sendSystemMessage(
      room,
      `${player.name}: choose another dice.`
    );

    return;
  }

  const version =
    ++room.turnVersion;

  schedule(
    room,
    ()=>{
      if (
        !room.started ||
        room.turnVersion!==version
      ) {
        return;
      }

      nextTurn(room);
    },
    850
  );
}


/* =========================================================
   CHAT
========================================================= */

function handleChat(
  socket,
  message
) {

  const room =
    findRoomByPlayer(
      socket.id
    );

  if (!room) return;

  const player =
    room.players.find(
      p=>p.id===socket.id
    );

  if (!player) return;

  let text;

  if (
    typeof message ===
    "object"
  ) {

    text =
      String(
        message.text ||
        message.message ||
        ""
      );

  } else {

    text =
      String(
        message || ""
      );
  }

  text =
    text
      .trim()
      .slice(0,150);

  if (!text) return;

  io.to(room.id).emit(
    "receiveChatMessage",
    {
      playerId:player.id,

      name:player.name,

      color:player.color,

      text,

      message:text
    }
  );
}


/* =========================================================
   VOICE
========================================================= */

function handleVoiceJoin(
  socket
) {

  const room =
    findRoomByPlayer(
      socket.id
    );

  if (!room) return;

  const peers =
    room.players
      .filter(
        p=>p.id!==socket.id
      )
      .map(
        p=>p.id
      );

  socket.emit(
    "voicePeers",
    peers
  );

  socket.to(room.id).emit(
    "voiceUserJoined",
    {
      playerId:socket.id
    }
  );
}


function handleVoiceSignal(
  socket,
  data
) {

  if (!data) return;

  const target =
    data.to ||
    data.target;

  if (!target) return;

  const room =
    findRoomByPlayer(
      socket.id
    );

  if (!room) return;

  const isInRoom =
    room.players.some(
      p=>p.id===target
    );

  if (!isInRoom) return;

  const payload =
    data.data ||
    data.signal;

  if (!payload) return;

  io.to(target).emit(
    "voiceSignal",
    {
      from:socket.id,

      data:payload,

      signal:payload
    }
  );
}


/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on(
  "connection",
  socket=>{

    console.log(
      "Connected:",
      socket.id
    );

    socket.on(
      "joinPublicGame",
      numberOfPlayers=>{

        joinPublicGame(
          socket,
          numberOfPlayers
        );
      }
    );

    socket.on(
      "joinGame",
      numberOfPlayers=>{

        joinPublicGame(
          socket,
          numberOfPlayers
        );
      }
    );

    socket.on(
      "createPrivateGame",
      numberOfPlayers=>{

        createPrivateGame(
          socket,
          numberOfPlayers
        );
      }
    );

    socket.on(
      "joinPrivateGame",
      code=>{

        joinPrivateGame(
          socket,
          code
        );
      }
    );

    socket.on(
      "requestRoll",
      ()=>{

        const room =
          findRoomByPlayer(
            socket.id
          );

        handleRequestRoll(
          socket,
          room
        );
      }
    );

    socket.on(
      "requestMove",
      data=>{

        const room =
          findRoomByPlayer(
            socket.id
          );

        handleRequestMove(
          socket,
          room,
          data
        );
      }
    );

    socket.on(
      "sendChatMessage",
      message=>{

        handleChat(
          socket,
          message
        );
      }
    );

    socket.on(
      "voiceJoin",
      ()=>{

        handleVoiceJoin(
          socket
        );
      }
    );

    socket.on(
      "voiceSignal",
      data=>{

        handleVoiceSignal(
          socket,
          data
        );
      }
    );

    socket.on(
      "leaveRoom",
      ()=>{

        leaveQueue(
          socket.id
        );

        const room =
          findRoomByPlayer(
            socket.id
          );

        if (room) {

          closeRoom(
            room,
            "The room was closed because a player left."
          );

          socket.leave(
            room.id
          );
        }
      }
    );

    socket.on(
      "disconnect",
      ()=>{

        console.log(
          "Disconnected:",
          socket.id
        );

        leaveQueue(
          socket.id
        );

        const room =
          findRoomByPlayer(
            socket.id
          );

        if (room) {

          closeRoom(
            room,
            "A player disconnected. The room was closed."
          );
        }
      }
    );

  }
);


/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  ()=>{
    console.log(
      `Ludo Twist running on port ${PORT}`
    );
  }
);
