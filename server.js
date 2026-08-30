const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

app.use(express.static(path.join(__dirname)));

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = {};


/* =========================================================
   CONNECTION
========================================================= */

io.on("connection", socket => {

    console.log(
        "User connected:",
        socket.id
    );


    /* =====================================================
       PUBLIC MATCHMAKING
    ===================================================== */

    socket.on("joinGame", numPlayers => {

        numPlayers =
            Number(numPlayers);


        if(
            ![2,3,4].includes(
                numPlayers
            )
        ){

            socket.emit(
                "roomError",
                "Invalid player count."
            );

            return;

        }


        leaveQueues(socket);


        publicQueues[
            numPlayers
        ].push(socket);


        const count=
            publicQueues[
                numPlayers
            ].length;


        if(count>=numPlayers){

            const matched=
                publicQueues[
                    numPlayers
                ].splice(
                    0,
                    numPlayers
                );


            const roomId=
                "public_"+randomCode();


            createRoom(
                roomId,
                matched,
                false,
                numPlayers
            );


        }else{

            socket.emit(
                "systemMessage",
                `Waiting for ${
                    numPlayers-count
                } more player(s)...`
            );

        }

    });


    /* =====================================================
       CREATE PRIVATE ROOM
    ===================================================== */

    socket.on(
        "createPrivateGame",
        numPlayers => {

            numPlayers=
                Number(numPlayers);


            if(
                ![2,3,4].includes(
                    numPlayers
                )
            ){

                socket.emit(
                    "roomError",
                    "Invalid player count."
                );

                return;

            }


            leaveQueues(socket);


            let code;


            do{

                code=
                    randomCode();

            }while(rooms[code]);


            rooms[code]={

                id:code,

                maxPlayers:numPlayers,

                players:[socket],

                started:false,

                currentIndex:0

            };


            socket.roomId=code;

            socket.join(code);


            socket.emit(
                "privateRoomCreated",
                code
            );


            io.to(code).emit(
                "systemMessage",
                `Private room ${
                    code
                } created. Waiting for players...`
            );

        }
    );


    /* =====================================================
       JOIN PRIVATE ROOM
    ===================================================== */

    socket.on(
        "joinPrivateGame",
        rawCode => {

            const code=
                String(rawCode)
                .trim()
                .toUpperCase();


            const room=
                rooms[code];


            if(!room){

                socket.emit(
                    "roomError",
                    "Room code not found."
                );

                return;

            }


            if(room.started){

                socket.emit(
                    "roomError",
                    "Game has already started."
                );

                return;

            }


            if(
                room.players.length>=
                room.maxPlayers
            ){

                socket.emit(
                    "roomError",
                    "Room is full."
                );

                return;

            }


            leaveQueues(socket);


            room.players.push(socket);

            socket.roomId=code;

            socket.join(code);


            io.to(code).emit(
                "systemMessage",
                `Players ${
                    room.players.length
                }/${room.maxPlayers}`
            );


            if(
                room.players.length===
                room.maxPlayers
            ){

                startRoom(
                    room
                );

            }

        }
    );


    /* =====================================================
       CHAT
    ===================================================== */

    socket.on(
        "sendChatMessage",
        data => {

            const room=
                getRoom(socket);


            if(!room)
                return;


            io.to(room.id).emit(
                "receiveChatMessage",
                {
                    name:
                        String(
                            data.name || "Player"
                        ),
                    text:
                        String(
                            data.text || ""
                        ).slice(0,300)
                }
            );

        }
    );


    /* =====================================================
       VOICE
    ===================================================== */

    socket.on(
        "voiceData",
        buffer => {

            const room=
                getRoom(socket);


            if(!room)
                return;


            socket
                .to(room.id)
                .emit(
                    "voiceData",
                    buffer
                );

        }
    );


    /* =====================================================
       ROLL
    ===================================================== */

    socket.on(
        "requestRoll",
        data => {

            const room=
                getRoom(socket);


            if(!room || !room.started)
                return;


            const playerId=
                Number(data.playerId);


            /*
              The server only accepts a roll from
              the socket that owns the current player.
            */

            const index=
                room.players.findIndex(
                    s=>
                        s.playerIndex===
                        playerId
                );


            if(index===-1)
                return;


            if(
                room.players[
                    room.currentIndex
                ].playerIndex!==
                playerId
            ){

                return;

            }


            const value=
                Number(
                    data.rollValue
                );


            if(
                ![1,2,3,4,8].includes(
                    value
                )
            )
                return;


            io.to(room.id).emit(
                "executeRoll",
                {
                    playerId,
                    rollValue:value
                }
            );

        }
    );


    /* =====================================================
       MOVE
    ===================================================== */

    socket.on(
        "requestMove",
        data => {

            const room=
                getRoom(socket);


            if(!room || !room.started)
                return;


            const playerId=
                Number(data.playerId);


            const pawnIndex=
                Number(data.pawnIndex);


            if(
                !Number.isInteger(
                    pawnIndex
                ) ||
                pawnIndex<0 ||
                pawnIndex>3
            )
                return;


            /*
              Verify the socket owns the player.
            */

            const owner=
                room.players.find(
                    s=>
                        s.playerIndex===
                        playerId
                );


            if(
                !owner ||
                owner.id!==socket.id
            ){

                return;

            }


            /*
              Verify this is the current player.
            */

            if(
                room.players[
                    room.currentIndex
                ].playerIndex!==
                playerId
            ){

                return;

            }


            io.to(room.id).emit(
                "executeMove",
                {
                    playerId,
                    pawnIndex
                }
            );

        }
    );


    /* =====================================================
       STATE SYNC
    ===================================================== */

    socket.on(
        "syncState",
        state => {

            const room=
                getRoom(socket);


            if(!room || !room.started)
                return;


            /*
              Do not let an arbitrary client change
              room membership or player ownership.
            */

            if(
                !state ||
                !Array.isArray(
                    state.players
                )
            )
                return;


            room.currentIndex=
                Number(
                    state.currentIndex
                );


            socket
                .to(room.id)
                .emit(
                    "forceSync",
                    {
                        currentIndex:
                            state.currentIndex,

                        canRoll:
                            Boolean(
                                state.canRoll
                            ),

                        rolledNumber:
                            state.rolledNumber,

                        players:
                            state.players
                    }
                );

        }
    );


    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
        "disconnect",
        () => {

            console.log(
                "User disconnected:",
                socket.id
            );


            leaveQueues(socket);


            const room=
                getRoom(socket);


            if(room){

                room.players=
                    room.players.filter(
                        s=>
                            s.id!==socket.id
                    );


                if(room.players.length===0){

                    delete rooms[
                        room.id
                    ];

                }else{

                    room.started=false;

                    io.to(room.id).emit(
                        "systemMessage",
                        "A player disconnected."
                    );

                }

            }

        }
    );

});


/* =========================================================
   ROOM FUNCTIONS
========================================================= */

function createRoom(
    roomId,
    sockets,
    isPrivate,
    maxPlayers
){

    rooms[roomId]={

        id:roomId,

        maxPlayers,

        players:sockets,

        started:false,

        currentIndex:0

    };


    sockets.forEach(
        (socket,index)=>{

            socket.roomId=
                roomId;

            socket.playerIndex=
                index;

            socket.join(roomId);

        }
    );


    startRoom(
        rooms[roomId]
    );

}


function startRoom(room){

    if(room.started)
        return;


    if(
        room.players.length!==
        room.maxPlayers
    )
        return;


    room.started=true;

    room.currentIndex=0;


    room.players.forEach(
        (socket,index)=>{

            socket.playerIndex=
                index;

            socket.emit(
                "assignPlayer",
                index
            );

        }
    );


    const ids=
        room.players.map(
            s=>s.playerIndex
        );


    io.to(room.id).emit(
        "gameStart",
        ids
    );


    io.to(room.id).emit(
        "systemMessage",
        "Match started! Blue goes first."
    );

}


/* =========================================================
   QUEUES
========================================================= */

function leaveQueues(socket){

    for(
        const key of Object.keys(
            publicQueues
        )
    ){

        publicQueues[key]=
            publicQueues[key].filter(
                s=>s.id!==socket.id
            );

    }

}


/* =========================================================
   GET ROOM
========================================================= */

function getRoom(socket){

    if(
        socket.roomId &&
        rooms[socket.roomId]
    ){

        return rooms[
            socket.roomId
        ];

    }


    return null;

}


/* =========================================================
   RANDOM ROOM CODE
========================================================= */

function randomCode(){

    return Math.random()
        .toString(36)
        .substring(2,8)
        .toUpperCase();

}


/* =========================================================
   SERVER
========================================================= */

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
