const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
    maxHttpBufferSize: 1e6
});

app.use(
    express.static(
        path.join(__dirname)
    )
);


/* =========================
   GAME QUEUES / ROOMS
========================= */

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const activeRooms = {};


/* =========================
   CONNECTION
========================= */

io.on('connection', socket => {

    console.log(
        `User connected: ${socket.id}`
    );


    /* =========================
       PUBLIC MATCHMAKING
    ========================= */

    socket.on(
        'joinGame',
        numPlayers => {

            numPlayers =
                Number(numPlayers);

            leaveAllQueues(socket.id);

            if(!publicQueues[numPlayers]){

                socket.emit(
                    'roomError',
                    'Invalid player count.'
                );

                return;

            }

            publicQueues[numPlayers]
                .push(socket);

            const queue=
                publicQueues[numPlayers];

            if(queue.length>=numPlayers){

                const matchedSockets=
                    queue.splice(
                        0,
                        numPlayers
                    );

                const roomId=
                    'pub_' +
                    Math.random()
                    .toString(36)
                    .substring(2,8);

                activeRooms[roomId]={
                    maxPlayers:numPlayers,
                    sockets:matchedSockets,
                    isPrivate:false,
                    started:false
                };

                matchedSockets.forEach(
                    sock=>{
                        sock.join(roomId);
                    }
                );

                setupRoom(
                    roomId,
                    matchedSockets
                );

            }else{

                socket.emit(
                    'systemMessage',
                    `Waiting for ${
                        numPlayers-queue.length
                    } more player(s)...`
                );

            }

        }
    );


    /* =========================
       CREATE PRIVATE ROOM
    ========================= */

    socket.on(
        'createPrivateGame',
        numPlayers => {

            numPlayers=
                Number(numPlayers);

            if(![2,3,4].includes(numPlayers)){

                socket.emit(
                    'roomError',
                    'Invalid player count.'
                );

                return;

            }

            leaveAllQueues(socket.id);

            const roomCode=
                Math.random()
                .toString(36)
                .substring(2,8)
                .toUpperCase();

            activeRooms[roomCode]={
                maxPlayers:numPlayers,
                sockets:[socket],
                isPrivate:true,
                started:false
            };

            socket.room=roomCode;

            socket.playerIndex=0;

            socket.join(roomCode);

            socket.emit(
                'assignPlayer',
                0
            );

            socket.emit(
                'privateRoomCreated',
                roomCode
            );

            socket.emit(
                'systemMessage',
                `Room ${roomCode} created. Waiting for players...`
            );

        }
    );


    /* =========================
       JOIN PRIVATE ROOM
    ========================= */

    socket.on(
        'joinPrivateGame',
        rawCode => {

            const code=
                String(rawCode)
                .trim()
                .toUpperCase();

            const room=
                activeRooms[code];

            if(!room){

                socket.emit(
                    'roomError',
                    'Room code not found!'
                );

                return;

            }

            if(room.started){

                socket.emit(
                    'roomError',
                    'Game has already started!'
                );

                return;

            }

            if(
                room.sockets.length>=
                room.maxPlayers
            ){

                socket.emit(
                    'roomError',
                    'Room is full!'
                );

                return;

            }

            leaveAllQueues(socket.id);

            room.sockets.push(socket);

            socket.room=code;

            socket.playerIndex=
                room.sockets.length-1;

            socket.join(code);

            io.to(code).emit(
                'systemMessage',
                `Player joined (${room.sockets.length}/${room.maxPlayers})...`
            );


            if(
                room.sockets.length===
                room.maxPlayers
            ){

                setupRoom(
                    code,
                    room.sockets
                );

            }

        }
    );


    /* =========================
       CHAT
    ========================= */

    socket.on(
        'sendChatMessage',
        data => {

            const roomId=
                getSocketRoom(socket);

            if(!roomId) return;

            const name=
                String(data?.name || 'Player')
                .substring(0,30);

            const text=
                String(data?.text || '')
                .substring(0,300);

            if(!text.trim()) return;

            io.to(roomId).emit(
                'receiveChatMessage',
                {
                    name,
                    text
                }
            );

        }
    );


    /* =========================
       VOICE
    ========================= */

    socket.on(
        'voiceData',
        audioData => {

            const roomId=
                getSocketRoom(socket);

            if(!roomId) return;

            socket
                .to(roomId)
                .emit(
                    'voiceData',
                    audioData
                );

        }
    );


    /* =========================
       ROLL
    ========================= */

    socket.on(
        'requestRoll',
        data => {

            const roomId=
                getSocketRoom(socket);

            if(!roomId) return;

            if(
                socket.playerIndex===
                undefined
            ) return;

            if(
                Number(data.playerId)!==
                socket.playerIndex
            ) return;

            const roll=
                Number(data.rollValue);

            if(
                ![1,2,3,4,8]
                .includes(roll)
            ) return;

            io.to(roomId).emit(
                'executeRoll',
                {
                    playerId:
                        socket.playerIndex,

                    rollValue:roll
                }
            );

        }
    );


    /* =========================
       MOVE
    ========================= */

    socket.on(
        'requestMove',
        data => {

            const roomId=
                getSocketRoom(socket);

            if(!roomId) return;

            if(
                socket.playerIndex===
                undefined
            ) return;

            if(
                Number(data.playerId)!==
                socket.playerIndex
            ) return;

            const pawnIndex=
                Number(data.pawnIndex);

            if(
                !Number.isInteger(pawnIndex) ||
                pawnIndex<0 ||
                pawnIndex>3
            ) return;

            io.to(roomId).emit(
                'executeMove',
                {
                    playerId:
                        socket.playerIndex,

                    pawnIndex
                }
            );

        }
    );


    /* =========================
       SYNC
    ========================= */

    socket.on(
        'syncState',
        state => {

            const roomId=
                getSocketRoom(socket);

            if(!roomId) return;

            socket
                .to(roomId)
                .emit(
                    'forceSync',
                    state
                );

        }
    );


    /* =========================
       DISCONNECT
    ========================= */

    socket.on(
        'disconnect',
        () => {

            console.log(
                `User disconnected: ${socket.id}`
            );

            leaveAllQueues(
                socket.id
            );

            const roomId=
                socket.room;

            if(roomId){

                const room=
                    activeRooms[roomId];

                if(room){

                    room.sockets=
                        room.sockets.filter(
                            s=>s.id!==socket.id
                        );

                    if(room.sockets.length===0){

                        delete activeRooms[roomId];

                    }else{

                        io.to(roomId).emit(
                            'systemMessage',
                            'A player disconnected.'
                        );

                    }

                }

            }

        }
    );

});


/* =========================
   SETUP ROOM
========================= */

function setupRoom(
    roomId,
    socketsArray
){

    const assignedIds=
        [0,1,2,3]
        .slice(
            0,
            socketsArray.length
        );

    if(activeRooms[roomId]){

        activeRooms[roomId].started=true;

    }

    socketsArray.forEach(
        (sock,index)=>{

            sock.room=roomId;

            sock.playerIndex=
                assignedIds[index];

            sock.emit(
                'assignPlayer',
                assignedIds[index]
            );

        }
    );

    io.to(roomId).emit(
        'gameStart',
        assignedIds
    );

    io.to(roomId).emit(
        'systemMessage',
        'Match started! Blue goes first.'
    );

}


/* =========================
   REMOVE FROM QUEUES
========================= */

function leaveAllQueues(
    socketId
){

    for(
        const key in publicQueues
    ){

        publicQueues[key]=
            publicQueues[key]
            .filter(
                s=>s.id!==socketId
            );

    }

}


/* =========================
   FIND ROOM
========================= */

function getSocketRoom(socket){

    if(socket.room){
        return socket.room;
    }

    for(
        const room of socket.rooms
    ){

        if(room!==socket.id){
            return room;
        }

    }

    return null;

}


/* =========================
   START SERVER
========================= */

const PORT=
    process.env.PORT || 3000;

server.listen(
    PORT,
    () => {

        console.log(
            `Server running on port ${PORT}`
        );

    }
);
