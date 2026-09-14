const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

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

const PATHS = [
 [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],
 [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],
 [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],
 [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
];

const SAFE = [2,10,12,14,22];

const COLORS = ['blue','red','green','yellow'];
const NAMES = ['Blue','Red','Green','Yellow'];

function makePlayer(id, socketId){
  return {
    id,
    socketId,
    name:NAMES[id],
    color:COLORS[id],
    pawns:[-1,-1,-1,-1],
    finished:0,
    connected:true
  };
}

function makeRoom(id,numPlayers,privateRoom){
  return {
    id,
    numPlayers,
    privateRoom,
    started:false,
    players:[],
    active:0,
    canRoll:true,

    // Each player can have several dice waiting.
    pendingRolls:{},

    voicePeers:new Set()
  };
}

function roomState(room){
  return {
    players:room.players.map(p=>({
      id:p.id,
      name:p.name,
      color:p.color,
      pawns:p.pawns,
      finished:p.finished,
      connected:p.connected
    })),
    active:room.active,
    canRoll:room.canRoll
  };
}

function publicStateFor(room,playerId){
  const state=roomState(room);

  state.pendingRollsByPlayer={};

  for(const p of room.players){
    state.pendingRollsByPlayer[p.id]=
      room.pendingRolls[p.id]||[];
  }

  state.myPendingRolls=
    room.pendingRolls[playerId]||[];

  return state;
}

function sendState(room){
  room.players.forEach(p=>{
    if(io.sockets.sockets.get(p.socketId)){
      io.to(p.socketId).emit(
        'stateUpdate',
        publicStateFor(room,p.id)
      );
    }
  });
}

function findRoomBySocket(socketId){
  for(const id in rooms){
    const room=rooms[id];

    if(room.players.some(p=>p.socketId===socketId)){
      return room;
    }
  }

  return null;
}

function leaveQueues(socketId){
  for(const n of [2,3,4]){
    publicQueues[n]=publicQueues[n].filter(
      id=>id!==socketId
    );
  }
}

function rollDiceValue(){

  // Rare lucky values:
  // 4 = 2.5%
  // 8 = 1.5%
  // Total lucky chance = 4%

  const r=Math.random();

  if(r<0.38)return 1;
  if(r<0.76)return 2;
  if(r<0.96)return 3;
  if(r<0.985)return 4;
  return 8;
}

function startRoom(room){
  room.started=true;
  room.active=0;
  room.canRoll=true;

  room.pendingRolls={};

  room.players.forEach(p=>{
    p.pawns=[-1,-1,-1,-1];
    p.finished=0;
    room.pendingRolls[p.id]=[];
  });

  room.players.forEach(p=>{
    io.to(p.socketId).emit('gameStart',{
      playerId:p.id,
      players:room.players.map(x=>({
        id:x.id,
        name:x.name,
        color:x.color,
        pawns:x.pawns,
        finished:x.finished,
        connected:x.connected
      })),
      active:room.active,
      canRoll:true
    });
  });

  sendState(room);
}

function addPlayerToRoom(room,socket){
  if(room.started){
    socket.emit('roomError','Game has already started.');
    return false;
  }

  if(room.players.length>=room.numPlayers){
    socket.emit('roomError','Room is full.');
    return false;
  }

  const playerId=room.players.length;

  const player=makePlayer(
    playerId,
    socket.id
  );

  room.players.push(player);
  room.pendingRolls[playerId]=[];

  socket.join(room.id);

  socket.data.roomId=room.id;
  socket.data.playerId=playerId;

  socket.emit('assignPlayer',{
    playerId
  });

  io.to(room.id).emit(
    'systemMessage',
    `${player.name} joined the room.`
  );

  if(room.players.length===room.numPlayers){
    startRoom(room);
  }else{
    socket.emit(
      'systemMessage',
      `Waiting for ${room.numPlayers-room.players.length} more player(s).`
    );
  }

  return true;
}

function removePlayerFromRoom(room,socketId){

  const index=room.players.findIndex(
    p=>p.socketId===socketId
  );

  if(index<0)return;

  const player=room.players[index];

  if(room.started){
    player.connected=false;

    io.to(room.id).emit(
      'systemMessage',
      `${player.name} disconnected.`
    );

    sendState(room);
    return;
  }

  room.players.splice(index,1);

  room.players.forEach((p,i)=>{
    p.id=i;
  });

  if(room.players.length===0){
    delete rooms[room.id];
    return;
  }

  room.players.forEach(p=>{
    room.pendingRolls[p.id]=
      room.pendingRolls[p.id]||[];
  });

  io.to(room.id).emit(
    'systemMessage',
    `${player.name} left the room.`
  );
}

function validPlayer(room,socket){
  const p=room.players.find(
    x=>x.socketId===socket.id
  );

  if(!p){
    socket.emit('roomError','You are not in this game.');
    return null;
  }

  return p;
}

function requestRoll(socket){

  const room=findRoomBySocket(socket.id);

  if(!room || !room.started){
    socket.emit('roomError','Game has not started.');
    return;
  }

  const player=validPlayer(room,socket);

  if(!player)return;

  if(room.active!==player.id){
    socket.emit('roomError','It is not your turn.');
    return;
  }

  if(!room.canRoll){
    socket.emit(
      'roomError',
      'Choose a pawn before rolling again.'
    );
    return;
  }

  const rolls=room.pendingRolls[player.id]||[];

  // A lucky roll gives an extra roll before moving.
  // Once the player uses that permission, the next roll is normal.
  const extraPermissionIndex=
    rolls.findIndex(r=>r.extraAvailable===true);

  if(extraPermissionIndex>=0){
    rolls[extraPermissionIndex].extraAvailable=false;
  }

  const value=rollDiceValue();
  const lucky=value===4 || value===8;

  rolls.push({
    value,
    extraAvailable:lucky
  });

  room.pendingRolls[player.id]=rolls;

  // If lucky, player can roll again before moving.
  room.canRoll=lucky;

  io.to(room.id).emit('rollResult',{
    playerId:player.id,
    value,
    lucky,
    pendingRolls:rolls,
    canRoll:room.canRoll
  });

  sendState(room);
}

function requestMove(socket,data){

  const room=findRoomBySocket(socket.id);

  if(!room || !room.started)return;

  const player=validPlayer(room,socket);

  if(!player)return;

  if(room.active!==player.id){
    socket.emit('roomError','It is not your turn.');
    return;
  }

  if(!Number.isInteger(data.pawnIndex) ||
     data.pawnIndex<0 ||
     data.pawnIndex>3){
    socket.emit('roomError','Invalid pawn.');
    return;
  }

  const rolls=room.pendingRolls[player.id]||[];

  const rollIndex=Number.isInteger(data.rollIndex)
    ? data.rollIndex
    : 0;

  if(rollIndex<0 || rollIndex>=rolls.length){
    socket.emit('roomError','Invalid dice.');
    return;
  }

  const rollObj=rolls[rollIndex];

  const pawnIndex=data.pawnIndex;
  let step=player.pawns[pawnIndex];

  if(step===24){
    socket.emit(
      'roomError',
      'That pawn is already HOME.'
    );
    return;
  }

  if(step===-1){
    step=0;
  }else{
    step+=rollObj.value;
  }

  if(step>24){
    socket.emit(
      'roomError',
      'That pawn cannot use this dice.'
    );
    return;
  }

  rolls.splice(rollIndex,1);

  player.pawns[pawnIndex]=step;

  let captured=false;

  if(step>=0 && step<24){

    const cell=PATHS[player.id][step];

    if(!SAFE.includes(cell)){

      for(const opponent of room.players){

        if(opponent.id===player.id)continue;
        if(!opponent.connected)continue;

        for(let i=0;i<4;i++){

          const otherStep=opponent.pawns[i];

          if(
            otherStep>=0 &&
            otherStep<24 &&
            PATHS[opponent.id][otherStep]===cell
          ){
            opponent.pawns[i]=-1;
            captured=true;
          }
        }
      }
    }
  }

  let reachedHome=false;

  if(step===24){
    player.finished++;
    reachedHome=true;
  }

  const extra =
    rollObj.extraAvailable ||
    captured ||
    reachedHome;

  room.pendingRolls[player.id]=rolls;

  if(player.finished>=4){

    room.canRoll=false;

    io.to(room.id).emit('moveResult',{
      playerId:player.id,
      pawnIndex,
      value:rollObj.value,
      captured,
      reachedHome,
      players:room.players.map(p=>({
        id:p.id,
        name:p.name,
        color:p.color,
        pawns:p.pawns,
        finished:p.finished,
        connected:p.connected
      })),
      active:room.active,
      pendingRolls:[],
      canRoll:false,
      message:`${player.name} WINS! 🏆`
    });

    sendState(room);
    return;
  }

  if(extra){
    room.canRoll=true;
  }else if(rolls.length>0){
    // More dice are stored, but the player must use them.
    room.canRoll=false;
  }else{
    room.active=(room.active+1)%room.players.length;
    room.canRoll=true;
  }

  io.to(room.id).emit('moveResult',{
    playerId:player.id,
    pawnIndex,
    value:rollObj.value,
    captured,
    reachedHome,
    players:room.players.map(p=>({
      id:p.id,
      name:p.name,
      color:p.color,
      pawns:p.pawns,
      finished:p.finished,
      connected:p.connected
    })),
    active:room.active,
    pendingRolls:room.pendingRolls[player.id],
    canRoll:room.canRoll,
    message:
      extra
      ?`${player.name} gets an extra roll!`
      :room.active===player.id
        ?`${player.name} continues.`
        :`${NAMES[room.active]}'s turn.`
  });

  sendState(room);
}

io.on('connection',socket=>{

  socket.on('joinPublic',data=>{

    const n=Number(data.players);

    if(![2,3,4].includes(n)){
      socket.emit(
        'roomError',
        'Players must be 2, 3 or 4.'
      );
      return;
    }

    leaveQueues(socket.id);

    publicQueues[n].push(socket.id);

    socket.emit(
      'systemMessage',
      `Searching for ${n} players...`
    );

    while(publicQueues[n].length>=n){

      const ids=publicQueues[n].splice(0,n);

      const roomId=
        'pub_'+Date.now()+'_'+Math.random()
          .toString(36)
          .slice(2,8);

      const room=makeRoom(
        roomId,
        n,
        false
      );

      rooms[roomId]=room;

      ids.forEach(id=>{
        const s=io.sockets.sockets.get(id);

        if(s){
          addPlayerToRoom(room,s);
        }
      });
    }
  });

  socket.on('createPrivate',data=>{

    const n=Number(data.players);

    if(![2,3,4].includes(n)){
      socket.emit(
        'roomError',
        'Players must be 2, 3 or 4.'
      );
      return;
    }

    const code=
      Math.random()
        .toString(36)
        .substring(2,7)
        .toUpperCase();

    const room=makeRoom(
      code,
      n,
      true
    );

    rooms[code]=room;

    addPlayerToRoom(room,socket);

    socket.emit(
      'privateRoomCreated',
      {
        code,
        players:n
      }
    );

    socket.emit('roomCode',code);
  });

  socket.on('joinPrivate',data=>{

    const code=
      String(data.code||'')
        .trim()
        .toUpperCase();

    const room=rooms[code];

    if(!room){
      socket.emit(
        'roomError',
        'Room not found.'
      );
      return;
    }

    addPlayerToRoom(room,socket);
  });

  socket.on('requestRoll',()=>{
    requestRoll(socket);
  });

  socket.on('requestMove',data=>{
    requestMove(socket,data||{});
  });

  socket.on('chatMessage',message=>{

    const room=findRoomBySocket(socket.id);

    if(!room)return;

    const player=room.players.find(
      p=>p.socketId===socket.id
    );

    if(!player)return;

    message=String(message||'')
      .trim()
      .slice(0,200);

    if(!message)return;

    io.to(room.id).emit(
      'chatMessage',
      {
        name:player.name,
        message
      }
    );
  });

  // =========================
  // VOICE CHAT
  // =========================

  socket.on('voiceJoin',()=>{

    const room=findRoomBySocket(socket.id);

    if(!room)return;

    room.voicePeers.add(socket.id);

    const others=
      [...room.voicePeers]
        .filter(id=>id!==socket.id);

    socket.emit('voicePeers',others);
  });

  socket.on('voiceLeave',()=>{

    const room=findRoomBySocket(socket.id);

    if(!room)return;

    room.voicePeers.delete(socket.id);

    socket.to(room.id).emit(
      'voicePeerLeft',
      socket.id
    );
  });

  socket.on('voiceSignal',data=>{

    if(!data || !data.to)return;

    const target=
      io.sockets.sockets.get(data.to);

    if(!target)return;

    if(data.type==='offer'){
      target.emit('voiceOffer',{
        from:socket.id,
        offer:data.offer
      });
    }

    else if(data.type==='answer'){
      target.emit('voiceAnswer',{
        from:socket.id,
        answer:data.answer
      });
    }

    else if(data.type==='candidate'){
      target.emit('voiceCandidate',{
        from:socket.id,
        candidate:data.candidate
      });
    }
  });

  socket.on('disconnect',()=>{

    leaveQueues(socket.id);

    const room=findRoomBySocket(socket.id);

    if(!room)return;

    room.voicePeers.delete(socket.id);

    socket.to(room.id).emit(
      'voicePeerLeft',
      socket.id
    );

    removePlayerFromRoom(
      room,
      socket.id
    );
  });
});

app.get('/',(req,res)=>{
  res.sendFile(
    path.join(__dirname,'index.html')
  );
});

server.listen(PORT,()=>{
  console.log(
    `Ludo Twist running on port ${PORT}`
  );
});
