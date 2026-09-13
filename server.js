const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();

const server =
    http.createServer(app);

const io =
    new Server(server, {
        cors:{
            origin:"*"
        }
    });

app.use(
    express.static(
        path.join(__dirname)
    )
);

const PORT =
    process.env.PORT || 3000;


/* =====================================================
   PLAYER DATA
===================================================== */

const playerInfo = [

    {
        id:0,
        name:"Blue",
        color:"#1e90ff",
        path:[
            10,15,20,21,22,
            23,24,19,14,9,
            4,3,2,1,0,
            5,6,7,8,13,
            18,17,16,11,12
        ]
    },

    {
        id:1,
        name:"Red",
        color:"#ff4757",
        path:[
            2,1,0,5,10,
            15,20,21,22,23,
            24,19,14,9,4,
            3,8,13,18,17,
            16,11,6,7,12
        ]
    },

    {
        id:2,
        name:"Green",
        color:"#2ed573",
        path:[
            14,9,4,3,2,
            1,0,5,10,15,
            20,21,22,23,24,
            19,18,17,16,11,
            6,7,8,13,12
        ]
    },

    {
        id:3,
        name:"Yellow",
        color:"#ffa502",
        path:[
            22,23,24,19,14,
            9,4,3,2,1,
            0,5,10,15,20,
            21,16,11,6,7,
            8,13,18,17,12
        ]
    }

];


/* =====================================================
   ROOMS
===================================================== */

const publicQueues = {
    2:[],
    3:[],
    4:[]
};

const rooms = {};


/* =====================================================
   PLAYER
===================================================== */

function makePlayer(id){

    const info =
        playerInfo[id];

    return {

        id:id,

        name:info.name,

        color:info.color,

        pawns:[
            0,0,0,0
        ],

        hasKilled:false,

        hasWon:false,

        winRank:0
    };
}


/* =====================================================
   ROOM
===================================================== */

function makeRoom(
    id,
    maxPlayers,
    isPrivate
){

    return {

        id:id,

        maxPlayers:
            maxPlayers,

        isPrivate:
            isPrivate,

        started:false,

        sockets:[],

        players:[],

        activeIndex:0,

        activeRolls:[],

        canRoll:false,

        currentRank:1,

        diceValues:[
            null,
            null,
            null,
            null
        ]
    };
}


/* =====================================================
   HELPERS
===================================================== */

function getRoom(socket){

    if(
        !socket.gameRoom
    ){
        return null;
    }

    return rooms[
        socket.gameRoom
    ] || null;
}

function currentPlayer(room){

    return room.players[
        room.activeIndex
    ];
}

function sendState(room){

    io.to(room.id).emit(
        "gameState",
        {
            players:
                room.players,

            activeIndex:
                room.activeIndex,

            activeRolls:
                room.activeRolls,

            canRoll:
                room.canRoll,

            diceValues:
                room.diceValues
        }
    );
}

function status(room,text){

    io.to(room.id).emit(
        "statusMessage",
        text
    );
}

function removeFromQueues(
    socketId
){

    [2,3,4].forEach(
        function(size){

            publicQueues[size] =
                publicQueues[size]
                    .filter(
                        function(id){
                            return id!==socketId;
                        }
                    );
        }
    );
}

function generateRoomCode(){

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code="";

    do{

        code="";

        for(
            let i=0;
            i<6;
            i++
        ){

            code +=
                chars[
                    Math.floor(
                        Math.random()*
                        chars.length
                    )
                ];
        }

    }while(rooms[code]);

    return code;
}

function validPlayer(
    room,
    socket,
    playerId
){

    return (
        room &&
        socket.gameRoom===
        room.id &&
        socket.playerIndex===
        Number(playerId) &&
        room.players[
            Number(playerId)
        ]
    );
}

function hasValidMove(
    player,
    value
){

    return player.pawns.some(
        function(step){

            return (
                step+
                value<=24
            );
        }
    );
}

function nextActiveIndex(room){

    if(
        !room.players.length
    ){
        return;
    }

    for(
        let i=0;
        i<room.players.length;
        i++
    ){

        room.activeIndex =
            (
                room.activeIndex+1
            )%
            room.players.length;

        if(
            !room.players[
                room.activeIndex
            ].hasWon
        ){

            return;
        }
    }
}

function advanceTurn(room){

    room.activeRolls=[];

    room.canRoll=true;

    nextActiveIndex(room);

    const player =
        currentPlayer(room);

    if(player){

        status(
            room,
            player.name+
            "'s turn."
        );
    }

    sendState(room);
}


/* =====================================================
   SETUP ROOM
===================================================== */

function setupRoom(room){

    room.players=[];

    room.sockets.forEach(
        function(socket,index){

            socket.playerIndex =
                index;

            socket.gameRoom =
                room.id;

            socket.join(
                room.id
            );

            room.players.push(
                makePlayer(index)
            );

            socket.emit(
                "assignPlayer",
                {
                    playerId:index,

                    playerName:
                        playerInfo[index]
                            .name
                }
            );
        }
    );

    room.started=true;

    room.activeIndex=0;

    room.activeRolls=[];

    room.canRoll=true;

    room.currentRank=1;

    io.to(room.id).emit(
        "gameStart"
    );

    status(
        room,
        "Match started! Blue goes first."
    );

    sendState(room);
}


/* =====================================================
   CLOSE ROOM
===================================================== */

function closeRoom(
    room,
    message
){

    if(!room){
        return;
    }

    room.sockets.forEach(
        function(socket){

            socket.emit(
                "roomClosed",
                message ||
                "Room closed."
            );

            socket.leave(
                room.id
            );

            socket.gameRoom=null;

            socket.playerIndex=null;
        }
    );

    delete rooms[
        room.id
    ];
}


/* =====================================================
   CONNECTION
===================================================== */

io.on(
    "connection",
    function(socket){

        console.log(
            "Connected:",
            socket.id
        );


        /* =============================================
           PUBLIC MATCHMAKING
        ============================================= */

        socket.on(
            "joinGame",
            function(count){

                count =
                    Number(count);

                if(
                    ![2,3,4].includes(count)
                ){

                    socket.emit(
                        "roomError",
                        "Invalid player count."
                    );

                    return;
                }

                removeFromQueues(
                    socket.id
                );

                const queue =
                    publicQueues[count];

                queue.push(
                    socket.id
                );

                socket.gameRoom=null;

                socket.playerIndex=null;

                statusForSocket(
                    socket,
                    "Waiting for "+
                    count+
                    " players..."
                );

                if(
                    queue.length>=count
                ){

                    const roomId =
                        "pub_"+
                        Date.now()+
                        "_"+
                        Math.random()
                            .toString(36)
                            .slice(2,7);

                    const room =
                        makeRoom(
                            roomId,
                            count,
                            false
                        );

                    rooms[
                        roomId
                    ]=room;

                    for(
                        let i=0;
                        i<count;
                        i++
                    ){

                        const id =
                            queue.shift();

                        const playerSocket =
                            io.sockets.sockets.get(
                                id
                            );

                        if(playerSocket){

                            room.sockets.push(
                                playerSocket
                            );
                        }
                    }

                    setupRoom(room);
                }
            }
        );


        /* =============================================
           PRIVATE CREATE
        ============================================= */

        socket.on(
            "createPrivateGame",
            function(count){

                count =
                    Number(count);

                if(
                    ![2,3,4].includes(count)
                ){

                    socket.emit(
                        "roomError",
                        "Invalid player count."
                    );

                    return;
                }

                removeFromQueues(
                    socket.id
                );

                const code =
                    generateRoomCode();

                const room =
                    makeRoom(
                        code,
                        count,
                        true
                    );

                rooms[code]=room;

                room.sockets.push(
                    socket
                );

                socket.gameRoom =
                    code;

                socket.playerIndex=null;

                socket.join(code);

                socket.emit(
                    "privateRoomCreated",
                    code
                );

                statusForSocket(
                    socket,
                    "Waiting for players..."
                );
            }
        );


        /* =============================================
           PRIVATE JOIN
        ============================================= */

        socket.on(
            "joinPrivateGame",
            function(code){

                code =
                    String(code)
                        .trim()
                        .toUpperCase();

                const room =
                    rooms[code];

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

                if(
                    room.sockets.length>=
                    room.maxPlayers
                ){

                    socket.emit(
                        "roomError",
                        "Room is full."
                    );

                    return;
                }

                room.sockets.push(
                    socket
                );

                socket.gameRoom =
                    code;

                socket.playerIndex=null;

                socket.join(code);

                statusForSocket(
                    socket,
                    "Joined private room. Waiting for players..."
                );

                if(
                    room.sockets.length===
                    room.maxPlayers
                ){

                    setupRoom(room);
                }
            }
        );


        /* =============================================
           ROLL
        ============================================= */

        socket.on(
            "requestRoll",
            function(){

                const room =
                    getRoom(socket);

                if(!room){

                    return;
                }

                if(!room.started){

                    return;
                }

                const player =
                    currentPlayer(room);

                if(!player){

                    return;
                }

                if(
                    socket.playerIndex!==
                    player.id
                ){

                    return;
                }

                if(!room.canRoll){

                    return;
                }

                if(
                    room.activeRolls.length
                ){

                    return;
                }

                const values=[
                    1,1,
                    2,2,
                    3,3,
                    4,
                    8
                ];

                const value =
                    values[
                        Math.floor(
                            Math.random()*
                            values.length
                        )
                    ];

                room.diceValues[
                    player.id
                ]=value;

                room.activeRolls=[
                    value
                ];

                room.canRoll=false;

                io.to(room.id).emit(
                    "diceRolled",
                    {
                        playerId:
                            player.id,

                        value:value
                    }
                );

                if(
                    !hasValidMove(
                        player,
                        value
                    )
                ){

                    room.activeRolls=[];

                    if(
                        value===4 ||
                        value===8
                    ){

                        room.canRoll=true;

                        status(
                            room,
                            player.name+
                            " rolled "+
                            value+
                            ". Extra roll!"
                        );

                        sendState(room);

                        return;
                    }

                    status(
                        room,
                        player.name+
                        " has no valid move."
                    );

                    setTimeout(
                        function(){

                            if(
                                !rooms[
                                    room.id
                                ]
                            ){
                                return;
                            }

                            advanceTurn(
                                room
                            );

                        },
                        700
                    );

                    return;
                }

                status(
                    room,
                    player.name+
                    " rolled "+
                    value+
                    ". Choose a pawn."
                );

                sendState(room);
            }
        );


        /* =============================================
           MOVE
        ============================================= */

        socket.on(
            "requestMove",
            function(data){

                const room =
                    getRoom(socket);

                if(!room){

                    return;
                }

                const playerId =
                    Number(
                        data.playerId
                    );

                const pawnIndex =
                    Number(
                        data.pawnIndex
                    );

                if(
                    !validPlayer(
                        room,
                        socket,
                        playerId
                    )
                ){

                    return;
                }

                const player =
                    room.players[
                        playerId
                    ];

                if(
                    room.activeIndex!==
                    playerId
                ){

                    return;
                }

                if(
                    !room.activeRolls.length
                ){

                    return;
                }

                if(
                    !Number.isInteger(
                        pawnIndex
                    ) ||
                    pawnIndex<0 ||
                    pawnIndex>3
                ){

                    return;
                }

                const roll =
                    Number(
                        room.activeRolls[0]
                    );

                const from =
                    Number(
                        player.pawns[
                            pawnIndex
                        ]
                    );

                const to =
                    from+roll;

                if(to>24){

                    return;
                }

                player.pawns[
                    pawnIndex
                ]=to;

                room.activeRolls=[];

                const targetCell =
                    playerInfo[
                        player.id
                    ].path[to];

                let extraTurn=false;

                const captured=[];


                /* =====================================
                   HOME
                ===================================== */

                if(
                    to===24
                ){

                    if(
                        player.pawns.every(
                            function(step){
                                return step===24;
                            }
                        )
                    ){

                        player.hasWon=true;

                        player.winRank =
                            room.currentRank;

                        room.currentRank++;

                        status(
                            room,
                            player.name+
                            " finished #"+
                            player.winRank+
                            "!"
                        );

                    }else{

                        extraTurn=true;

                        status(
                            room,
                            player.name+
                            " reached HOME! Extra turn."
                        );
                    }
                }


                /* =====================================
                   CAPTURE
                ===================================== */

                if(
                    to<24 &&
                    SAFE_CELLS.indexOf(
                        targetCell
                    )===-1
                ){

                    room.players.forEach(
                        function(opponent){

                            if(
                                opponent.id===
                                player.id
                            ){
                                return;
                            }

                            if(
                                opponent.hasWon
                            ){
                                return;
                            }

                            opponent.pawns.forEach(
                                function(
                                    opponentStep,
                                    index
                                ){

                                    if(
                                        opponentStep<
                                        24 &&
                                        playerInfo[
                                            opponent.id
                                        ].path[
                                            opponentStep
                                        ]===
                                        targetCell
                                    ){

                                        opponent.pawns[
                                            index
                                        ]=0;

                                        captured.push(
                                            {
                                                playerId:
                                                    opponent.id,

                                                pawnIndex:
                                                    index
                                            }
                                        );

                                        player.hasKilled=
                                            true;

                                        extraTurn=
                                            true;
                                    }
                                }
                            );
                        }
                    );

                    if(
                        captured.length
                    ){

                        status(
                            room,
                            player.name+
                            " captured an opponent! Extra turn."
                        );
                    }
                }


                io.to(room.id).emit(
                    "moveResult",
                    {
                        playerId:
                            player.id,

                        pawnIndex:
                            pawnIndex,

                        from:
                            from,

                        to:
                            to,

                        captured:
                            captured
                    }
                );


                /* =====================================
                   GAME END
                ===================================== */

                if(player.hasWon){

                    const remaining =
                        room.players.filter(
                            function(p){
                                return !p.hasWon;
                            }
                        );

                    if(
                        remaining.length<=1
                    ){

                        room.canRoll=false;

                        sendState(room);

                        io.to(room.id).emit(
                            "gameFinished"
                        );

                        return;
                    }

                    nextActiveIndex(
                        room
                    );

                    room.canRoll=true;

                }else if(extraTurn){

                    room.canRoll=true;

                }else{

                    nextActiveIndex(
                        room
                    );

                    room.canRoll=true;
                }

                const next =
                    currentPlayer(room);

                if(next){

                    if(!extraTurn){

                        status(
                            room,
                            next.name+
                            "'s turn."
                        );
                    }
                }

                sendState(room);
            }
        );


        /* =============================================
           CHAT
        ============================================= */

        socket.on(
            "sendChatMessage",
            function(data){

                const room =
                    getRoom(socket);

                if(!room){

                    return;
                }

                const text =
                    String(
                        data &&
                        data.text
                            ? data.text
                            : ""
                    )
                    .trim()
                    .slice(0,300);

                if(!text){

                    return;
                }

                const player =
                    room.players[
                        socket.playerIndex
                    ];

                if(!player){

                    return;
                }

                /*
                  IMPORTANT:
                  Only receiveChatMessage is emitted.
                  No status/system messages are sent
                  to the chat box.
                */

                io.to(room.id).emit(
                    "receiveChatMessage",
                    {
                        name:
                            player.name,

                        text:
                            text
                    }
                );
            }
        );


        /* =============================================
           WEBRTC OFFER
        ============================================= */

        socket.on(
            "voiceOffer",
            function(data){

                relayVoice(
                    socket,
                    data,
                    "voiceOffer"
                );
            }
        );


        /* =============================================
           WEBRTC ANSWER
        ============================================= */

        socket.on(
            "voiceAnswer",
            function(data){

                relayVoice(
                    socket,
                    data,
                    "voiceAnswer"
                );
            }
        );


        /* =============================================
           ICE
        ============================================= */

        socket.on(
            "iceCandidate",
            function(data){

                relayVoice(
                    socket,
                    data,
                    "iceCandidate"
                );
            }
        );


        /* =============================================
           DISCONNECT
        ============================================= */

        socket.on(
            "disconnect",
            function(){

                console.log(
                    "Disconnected:",
                    socket.id
                );

                removeFromQueues(
                    socket.id
                );

                const room =
                    getRoom(socket);

                if(room){

                    /*
                      For now close the room when
                      someone disconnects. This prevents
                      a broken multiplayer state.
                    */

                    closeRoom(
                        room,
                        "A player disconnected. Room closed."
                    );
                }
            }
        );

    }
);


/* =====================================================
   SOCKET STATUS
===================================================== */

function statusForSocket(
    socket,
    message
){

    socket.emit(
        "statusMessage",
        message
    );
}


/* =====================================================
   VOICE RELAY
===================================================== */

function relayVoice(
    socket,
    data,
    eventName
){

    const room =
        getRoom(socket);

    if(!room){

        return;
    }

    const targetId =
        Number(
            data &&
            data.to
        );

    if(
        !Number.isInteger(
            targetId
        )
    ){

        return;
    }

    const target =
        room.sockets.find(
            function(s){
                return (
                    s.playerIndex===
                    targetId
                );
            }
        );

    if(!target){

        return;
    }

    const payload =
        Object.assign(
            {},
            data,
            {
                from:
                    socket.playerIndex
            }
        );

    target.emit(
        eventName,
        payload
    );
}


/* =====================================================
   START SERVER
===================================================== */

server.listen(
    PORT,
    "0.0.0.0",
    function(){

        console.log(
            "🎲 Ludo Twist server running on port "+
            PORT
        );
    }
);
