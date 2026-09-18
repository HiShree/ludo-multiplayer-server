const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
  cors:{
    origin:"*"
  }
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

/* =========================
   GAME CONSTANTS
========================= */

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

const DICE_VALUES = [1,1,2,2,3,3,4,8];

/* =========================
   STORAGE
========================= */

const queues={
  2:[],
  3:[],
  4:[]
};

const rooms=new Map();

/* =========================
   PLAYER
========================= */

function makePlayer(id){

  return {
    id,
    name:NAMES[id],
    color:COLORS[id],
    pawns:[0,0,0,0],
    hasKilled:false,
    hasWon:false,
    rank:0,
    lastRoll:null
  };
}

/* =========================
   ROOM
========================= */

function makeRoom(id,maxPlayers,isPrivate){

  return {
    id,
    maxPlayers,
    isPrivate,

    sockets:[],
    players:[],

    started:false,
    finished:false,

    active:0,

    pendingRolls:[],
    canRoll:true,
    rollPermissionIndex:-1,

    rank:1
  };
}

function getRoom(socket){

  for(const room of rooms.values()){

    if(room.sockets.includes(socket)){
      return room;
    }

  }

  return null;
}

function getCurrentPlayer(room){

  return room.players[room.active];
}

/* =========================
   QUEUES
========================= */

function removeFromQueues(socket){

  for(const count of [2,3,4]){

    queues[count]=queues[count]
      .filter(s=>s!==socket);

  }
}

/* =========================
   ROOM CODE
========================= */

function makeRoomCode(){

  let code;

  do{

    code=Math.random()
      .toString(36)
      .substring(2,7)
      .toUpperCase();

  }while(rooms.has(code));

  return code;
}

/* =========================
   TURN
========================= */

function nextActive(room){

  let tries=0;

  do{

    room.active=
      (room.active+1)%room.players.length;

    tries++;

  }while(
    room.players[room.active].hasWon &&
    tries<=room.players.length
  );

  room.pendingRolls=[];
  room.canRoll=true;
  room.rollPermissionIndex=-1;
}

/* =========================
   MOVEMENT
========================= */

function isValidMove(player,pawnIndex,roll){

  if(!player || player.hasWon){
    return false;
  }

  if(!Number.isInteger(pawnIndex)){
    return false;
  }

  if(pawnIndex<0 || pawnIndex>3){
    return false;
  }

  const step=player.pawns[pawnIndex];

  if(step>=24){
    return false;
  }

  const maximum=
    player.hasKilled
      ? 24
      : 15;

  return step+roll<=maximum;
}

function hasValidMove(player,roll){

  return player.pawns.some(
    (_,index)=>
      isValidMove(player,index,roll)
  );
}

/* =========================
   CAPTURE
========================= */

function captureOpponents(
  room,
  playerIndex,
  newStep
){

  if(newStep>=24){
    return [];
  }

  const boardCell=
    PATHS[playerIndex][newStep];

  if(SAFE.includes(boardCell)){
    return [];
  }

  const captured=[];

  room.players.forEach((opponent,oi)=>{

    if(oi===playerIndex){
      return;
    }

    if(opponent.hasWon){
      return;
    }

    opponent.pawns.forEach((step,pi)=>{

      if(step>=24){
        return;
      }

      const opponentCell=
        PATHS[oi][step];

      if(opponentCell===boardCell){

        opponent.pawns[pi]=0;

        captured.push({
          playerId:opponent.id,
          pawnIndex:pi
        });
      }

    });

  });

  return captured;
}

/* =========================
   PUBLIC STATE
========================= */

function publicState(room){

  return {
    active:room.active,

    pendingRolls:
      room.pendingRolls.map(d=>({
        id:d.id,
        value:d.value,
        extraAvailable:d.extraAvailable
      })),

    canRoll:room.canRoll,

    rollPermissionIndex:
      room.rollPermissionIndex,

    rank:room.rank,

    finished:room.finished,

    players:
      room.players.map(p=>({
        id:p.id,
        name:p.name,
        color:p.color,
        pawns:[...p.pawns],
        hasKilled:p.hasKilled,
        hasWon:p.hasWon,
        rank:p.rank,
        lastRoll:p.lastRoll
      }))
  };
}

function sendState(room){

  const state=publicState(room);

  room.sockets.forEach(socket=>{
    socket.emit("gameState",state);
  });
}

function sendMessage(room,message){

  room.sockets.forEach(socket=>{
    socket.emit("systemMessage",message);
  });
}

/* =========================
   FINISH CHECK
========================= */

function checkGameFinished(room){

  const remaining=
    room.players.filter(p=>!p.hasWon);

  if(remaining.length<=1){

    if(remaining.length===1){

      const last=remaining[0];

      last.hasWon=true;
      last.rank=room.rank++;
    }

    room.finished=true;

    sendState(room);

    const winner=
      room.players
        .slice()
        .sort((a,b)=>a.rank-b.rank)
        .find(Boolean);

    if(winner){

      room.sockets.forEach(socket=>{
        socket.emit("gameFinished",{
          playerId:winner.id,
          playerName:winner.name
        });
      });
    }

    return true;
  }

  return false;
}

/* =========================
   CLOSE ROOM
========================= */

function closeRoom(room,message){

  room.sockets.forEach(socket=>{

    socket.emit(
      "roomClosed",
      message || "Room closed."
    );

    socket.leave(room.id);
  });

  room.sockets=[];
  room.players=[];

  rooms.delete(room.id);
}

/* =========================
   START ROOM
========================= */

function startRoom(room){

  if(room.started){
    return;
  }

  room.started=true;

  room.players=[];

  room.sockets.forEach((socket,index)=>{

    const player=makePlayer(index);

    room.players.push(player);

    socket.join(room.id);

    socket.data.roomId=room.id;
    socket.data.playerId=index;

    socket.emit("assignPlayer",{
      playerId:index,
      playerName:player.name
    });

  });

  room.active=0;
  room.pendingRolls=[];
  room.canRoll=true;
  room.rollPermissionIndex=-1;
  room.rank=1;

  room.sockets.forEach(socket=>{
    socket.emit("gameStart",{
      players:room.players
    });
  });

  sendMessage(
    room,
    "Game started! Blue goes first."
  );

  sendState(room);
}

/* =========================
   PUBLIC MATCHMAKING
========================= */

function joinGame(socket,numPlayers){

  numPlayers=Number(numPlayers);

  if(![2,3,4].includes(numPlayers)){

    socket.emit(
      "roomError",
      "Choose 2, 3 or 4 players."
    );

    return;
  }

  removeFromQueues(socket);

  queues[numPlayers].push(socket);

  socket.emit(
    "systemMessage",
    "Waiting for players..."
  );

  if(queues[numPlayers].length<numPlayers){
    return;
  }

  const sockets=[];

  while(
    sockets.length<numPlayers &&
    queues[numPlayers].length
  ){

    const s=queues[numPlayers].shift();

    if(s && s.connected){
      sockets.push(s);
    }

  }

  if(sockets.length<numPlayers){

    sockets.forEach(s=>{
      queues[numPlayers].push(s);
    });

    return;
  }

  const roomId=
    "pub_"+Date.now()+"_"+Math.random()
      .toString(36)
      .slice(2,7);

  const room=
    makeRoom(
      roomId,
      numPlayers,
      false
    );

  room.sockets=sockets;

  rooms.set(roomId,room);

  startRoom(room);
}

/* =========================
   SOCKET CONNECTION
========================= */

io.on("connection",socket=>{

  /* -------------------------
     PUBLIC GAME
  ------------------------- */

  socket.on("joinGame",numPlayers=>{
    joinGame(socket,numPlayers);
  });

  /* -------------------------
     PRIVATE CREATE
  ------------------------- */

  socket.on(
    "createPrivateGame",
    numPlayers=>{

      numPlayers=Number(numPlayers);

      if(![2,3,4].includes(numPlayers)){

        socket.emit(
          "roomError",
          "Choose 2, 3 or 4 players."
        );

        return;
      }

      removeFromQueues(socket);

      const code=makeRoomCode();

      const room=
        makeRoom(
          code,
          numPlayers,
          true
        );

      room.sockets.push(socket);

      rooms.set(code,room);

      socket.join(code);

      socket.data.roomId=code;

      socket.emit(
        "privateRoomCreated",
        code
      );

      socket.emit(
        "systemMessage",
        "Private room created. Share the code."
      );
    }
  );

  /* -------------------------
     PRIVATE JOIN
  ------------------------- */

  socket.on(
    "joinPrivateGame",
    code=>{

      code=
        String(code || "")
          .trim()
          .toUpperCase();

      const room=rooms.get(code);

      if(!room){

        socket.emit(
          "roomError",
          "Room not found."
        );

        return;
      }

      if(room.started){

        socket.emit(
          "roomError",
          "Game already started."
        );

        return;
      }

      if(room.sockets.length>=room.maxPlayers){

        socket.emit(
          "roomError",
          "Room is full."
        );

        return;
      }

      removeFromQueues(socket);

      room.sockets.push(socket);

      socket.join(room.id);

      socket.data.roomId=room.id;

      socket.emit(
        "systemMessage",
        "Joined private room."
      );

      if(
        room.sockets.length>=room.maxPlayers
      ){

        startRoom(room);
      }
    }
  );

  /* -------------------------
     ROLL
  ------------------------- */

  socket.on("requestRoll",()=>{

    const room=getRoom(socket);

    if(!room || !room.started){
      return;
    }

    if(room.finished){
      return;
    }

    const playerId=
      socket.data.playerId;

    if(playerId!==room.active){
      return;
    }

    if(!room.canRoll){
      return;
    }

    const player=
      room.players[playerId];

    if(!player || player.hasWon){
      return;
    }

    /*
      If an earlier 4/8 extra-roll permission
      was being used, that permission is consumed.
    */

    if(room.rollPermissionIndex>=0){

      const previous=
        room.pendingRolls[
          room.rollPermissionIndex
        ];

      if(previous){
        previous.extraAvailable=false;
      }

      room.rollPermissionIndex=-1;
    }

    const value=
      DICE_VALUES[
        Math.floor(
          Math.random()*DICE_VALUES.length
        )
      ];

    const die={
      id:
        Date.now().toString(36)+
        Math.random().toString(36).slice(2),

      value,

      extraAvailable:
        value===4 || value===8
    };

    room.pendingRolls.push(die);

    player.lastRoll=value;

    if(
      value===4 ||
      value===8
    ){

      room.canRoll=true;

      room.rollPermissionIndex=
        room.pendingRolls.length-1;

    }else{

      room.canRoll=false;
      room.rollPermissionIndex=-1;
    }

    room.sockets.forEach(s=>{
      s.emit("diceRolled",{
        playerId,
        playerName:player.name,
        value,
        rollId:die.id
      });
    });

    /*
      No possible move:
      automatically dismiss this die.
    */

    if(!hasValidMove(player,value)){

      room.pendingRolls=
        room.pendingRolls.filter(
          d=>d.id!==die.id
        );

      if(die.extraAvailable){

        room.canRoll=true;
        room.rollPermissionIndex=-1;

        sendMessage(
          room,
          player.name+
          " rolled "+value+
          " but has no move. Extra chance!"
        );

      }else if(room.pendingRolls.length>0){

        room.canRoll=false;

        sendMessage(
          room,
          player.name+
          " has no move for "+value+"."
        );

      }else{

        sendMessage(
          room,
          player.name+
          " has no possible move. Turn passed."
        );

        nextActive(room);
      }
    }

    sendState(room);
  });

  /* -------------------------
     MOVE
  ------------------------- */

  socket.on("requestMove",data=>{

    const room=getRoom(socket);

    if(!room || !room.started){
      return;
    }

    if(room.finished){
      return;
    }

    const playerId=
      socket.data.playerId;

    if(playerId!==room.active){
      return;
    }

    const player=
      room.players[playerId];

    if(!player || player.hasWon){
      return;
    }

    const pawnIndex=
      Number(data && data.pawnIndex);

    if(
      !Number.isInteger(pawnIndex) ||
      pawnIndex<0 ||
      pawnIndex>3
    ){
      return;
    }

    let rollIndex=
      room.pendingRolls.findIndex(
        d=>d.id===data.rollId
      );

    if(
      rollIndex<0 &&
      room.pendingRolls.length===1
    ){
      rollIndex=0;
    }

    if(rollIndex<0){
      return;
    }

    const die=
      room.pendingRolls[rollIndex];

    if(
      !isValidMove(
        player,
        pawnIndex,
        die.value
      )
    ){
      return;
    }

    const oldStep=
      player.pawns[pawnIndex];

    const newStep=
      oldStep+die.value;

    player.pawns[pawnIndex]=newStep;

    room.pendingRolls.splice(
      rollIndex,
      1
    );

    const captured=
      captureOpponents(
        room,
        playerId,
        newStep
      );

    if(captured.length>0){
      player.hasKilled=true;
    }

    const reachedHome=
      newStep===24;

    if(reachedHome){

      /*
        HOME gives an extra chance.
      */

      player.hasKilled=
        player.hasKilled || true;
    }

    const finishedNow=
      player.pawns.every(
        step=>step>=24
      );

    if(
      finishedNow &&
      !player.hasWon
    ){

      player.hasWon=true;
      player.rank=room.rank++;
    }

    let extraTurn=
      die.extraAvailable ||
      captured.length>0 ||
      reachedHome;

    if(player.hasWon){
      extraTurn=false;
    }

    /*
      A 4/8 die used to obtain an extra roll
      is no longer reusable.
    */

    if(room.pendingRolls.length===0){

      if(extraTurn){

        room.canRoll=true;
        room.rollPermissionIndex=-1;

      }else{

        nextActive(room);
      }

    }else{

      /*
        Other pending dice remain.
      */

      if(extraTurn){

        room.canRoll=true;
        room.rollPermissionIndex=-1;

      }else{

        room.canRoll=false;
      }
    }

    room.sockets.forEach(s=>{

      s.emit("moveResult",{
        playerId,
        playerName:player.name,
        pawnIndex,
        oldStep,
        newStep,
        captured,
        reachedHome,
        extraTurn
      });

    });

    if(finishedNow){

      room.sockets.forEach(s=>{

        s.emit("gameFinished",{
          playerId:player.id,
          playerName:player.name
        });

      });

      /*
        Do not close immediately because other
        players may still have a game state.
      */

      checkGameFinished(room);

    }

    sendState(room);
  });

  /* -------------------------
     CHAT
  ------------------------- */

  socket.on(
    "sendChatMessage",
    message=>{

      const room=getRoom(socket);

      if(!room) return;

      message=
        String(message || "")
          .trim()
          .slice(0,150);

      if(!message) return;

      const player=
        room.players[
          socket.data.playerId
        ];

      if(!player) return;

      /*
        Chat only.
        System/server messages are NOT sent
        through receiveChatMessage.
      */

      room.sockets.forEach(s=>{

        s.emit(
          "receiveChatMessage",
          {
            name:player.name,
            message
          }
        );

      });
    }
  );

  /* -------------------------
     VOICE
  ------------------------- */

  socket.on("voiceJoin",()=>{

    const room=getRoom(socket);

    if(!room){
      return;
    }

    const peers=
      room.sockets
        .filter(s=>s!==socket)
        .map(s=>s.id);

    socket.emit(
      "voicePeers",
      peers
    );
  });

  socket.on(
    "voiceSignal",
    data=>{

      const room=getRoom(socket);

      if(
        !room ||
        !data ||
        !data.to ||
        !data.data
      ){
        return;
      }

      const target=
        room.sockets.find(
          s=>s.id===data.to
        );

      if(!target){
        return;
      }

      target.emit(
        "voiceSignal",
        {
          from:socket.id,
          data:data.data
        }
      );
    }
  );

  /* -------------------------
     LEAVE ROOM
  ------------------------- */

  socket.on("leaveRoom",()=>{

    const room=getRoom(socket);

    if(!room){
      removeFromQueues(socket);
      return;
    }

    closeRoom(
      room,
      "A player left the game."
    );
  });

  /* -------------------------
     DISCONNECT
  ------------------------- */

  socket.on("disconnect",()=>{

    removeFromQueues(socket);

    const room=getRoom(socket);

    if(room){

      closeRoom(
        room,
        "A player disconnected."
      );
    }
  });

});

/* =========================
   SERVER
========================= */

server.listen(PORT,()=>{
  console.log(
    `Ludo Twist server running on port ${PORT}`
  );
});
