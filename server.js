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

app.use(
    express.static(
        path.join(__dirname)
    )
);


/* =========================================================
   CONSTANTS
========================================================= */

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

    [
        10,15,20,21,22,23,24,
        19,14,9,4,3,2,1,0,
        5,6,7,8,13,18,17,16,11,12
    ],

    [
        2,1,0,5,10,15,20,21,22,23,24,
        19,14,9,4,3,8,13,18,17,16,11,6,7,12
    ],

    [
        14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,
        19,18,17,16,11,6,7,8,13,12
    ],

    [
        22,23,24,19,14,9,4,3,2,1,0,
        5,10,15,20,21,16,11,6,7,8,13,18,17,12
    ]

];


const SAFE = [
    2,
    10,
    12,
    14,
    22
];


const DICE_VALUES = [
    1,1,
    2,2,
    3,3,
    4,
    8
];


/* =========================================================
   ROOMS
========================================================= */

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = {};


/* =========================================================
   PLAYER
========================================================= */

function makePlayer(
    id,
    socket
){

    return {

        id: id,

        socketId:
            socket.id,

        name:
            NAMES[id],

        color:
            COLORS[id],

        pawns: [
            0,
            0,
            0,
            0
        ],

        hasKilled: false,

        hasWon: false,

        rank: 0,

        lastRoll: null

    };

}


/* =========================================================
   ROOM
========================================================= */

function makeRoom(
    id,
    maxPlayers,
    isPrivate=false
){

    return {

        id: id,

        maxPlayers:
            maxPlayers,

        isPrivate:
            isPrivate,

        sockets: [],

        players: [],

        active: 0,

        pendingRolls: [],

        canRoll: true,

        rank: 1,

        started: false,

        finished: false

    };

}


/* =========================================================
   HELPERS
========================================================= */

function randomCode(){

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "";

    for(let i=0;i<6;i++){

        code +=
            chars[
                Math.floor(
                    Math.random() *
                    chars.length
                )
            ];

    }

    return code;

}


function getRoom(socket){

    return Object.values(rooms).find(
        room =>
            room.sockets.includes(socket)
    );

}


function getPlayer(
    room,
    socket
){

    return room.players.find(
        player =>
            player.socketId === socket.id
    );

}


function getPlayerById(
    room,
    playerId
){

    return room.players.find(
        player =>
            player.id === playerId
    );

}


function sendState(room){

    io.to(room.id).emit(
        "gameState",
        publicState(room)
    );

}


function publicState(room){

    return {

        active:
            room.active,

        canRoll:
            room.canRoll,

        rank:
            room.rank,

        finished:
            room.finished,

        players:
            room.players.map(
                player=>({

                    id:
                        player.id,

                    name:
                        player.name,

                    color:
                        player.color,

                    pawns:
                        [...player.pawns],

                    hasKilled:
                        player.hasKilled,

                    hasWon:
                        player.hasWon,

                    rank:
                        player.rank,

                    lastRoll:
                        player.lastRoll

                })
            ),

        pendingRolls:
            room.pendingRolls.map(
                die=>({

                    id:
                        die.id,

                    value:
                        die.value,

                    extraAvailable:
                        die.extraAvailable

                })
            )

    };

}


/* =========================================================
   PATH / MOVE HELPERS
========================================================= */

function getBoardCell(
    playerId,
    step
){

    if(
        step < 0 ||
        step >= PATHS[playerId].length
    ){
        return null;
    }

    return PATHS[playerId][step];

}


function maxStep(player){

    return player.hasKilled
        ? 24
        : 15;

}


function isValidMove(
    player,
    pawnIndex,
    roll
){

    if(!player){
        return false;
    }

    if(player.hasWon){
        return false;
    }

    if(
        pawnIndex < 0 ||
        pawnIndex > 3
    ){
        return false;
    }

    if(
        !Number.isInteger(roll) ||
        !DICE_VALUES.includes(roll)
    ){
        return false;
    }

    const step =
        player.pawns[pawnIndex];

    if(step >= 24){
        return false;
    }

    return (
        step + roll <=
        maxStep(player)
    );

}


function hasValidMove(
    player,
    roll
){

    return player.pawns.some(
        (_, index)=>
            isValidMove(
                player,
                index,
                roll
            )
    );

}


/* =========================================================
   CAPTURE
========================================================= */

function performCapture(
    room,
    player,
    to
){

    const captured = [];


    if(to >= 24){
        return captured;
    }


    const cell =
        getBoardCell(
            player.id,
            to
        );


    if(
        cell === null ||
        SAFE.includes(cell)
    ){
        return captured;
    }


    /*
       IMPORTANT:
       Only ONE opponent pawn is captured.

       The old code continued through every
       opponent and every pawn, so if two or
       more pawns were on the same square,
       all of them were sent HOME.

       We stop immediately after the first
       valid opponent pawn.
    */

    for(
        const opponent of room.players
    ){

        if(
            opponent.id === player.id ||
            opponent.hasWon
        ){
            continue;
        }


        for(
            let i = 0;
            i < 4;
            i++
        ){

            const step =
                opponent.pawns[i];

            if(step >= 24){
                continue;
            }


            const opponentCell =
                getBoardCell(
                    opponent.id,
                    step
                );


            if(
                opponentCell === cell
            ){

                opponent.pawns[i] = 0;

                captured.push({

                    playerId:
                        opponent.id,

                    pawnIndex:
                        i

                });


                /*
                   STOP after ONE capture.
                */

                return captured;

            }

        }

    }


    return captured;

}


/* =========================================================
   WINNING
========================================================= */

function checkPlayerWon(
    room,
    player
){

    if(
        player.pawns.every(
            step =>
                step === 24
        )
    ){

        if(!player.hasWon){

            player.hasWon = true;

            player.rank =
                room.rank++;

        }

        return true;

    }

    return false;

}


function checkGameFinished(room){

    const unfinished =
        room.players.filter(
            player =>
                !player.hasWon
        );


    /*
       If only one player remains,
       finish the ranking.
    */

    if(
        unfinished.length <= 1
    ){

        unfinished.forEach(
            player=>{

                player.hasWon = true;

                if(!player.rank){

                    player.rank =
                        room.rank++;

                }

            }
        );

        room.finished = true;

        return true;

    }


    return false;

}


/* =========================================================
   NEXT PLAYER
========================================================= */

function nextActive(room){

    if(room.finished){
        return;
    }


    for(
        let step = 1;
        step <= room.players.length;
        step++
    ){

        const index =
            (
                room.active +
                step
            ) %
            room.players.length;


        const player =
            room.players[index];


        if(
            player &&
            !player.hasWon
        ){

            room.active = index;

            break;

        }

    }


    room.pendingRolls = [];

    room.canRoll = true;

}


/* =========================================================
   START ROOM
========================================================= */

function startRoom(room){

    if(room.started){
        return;
    }


    if(
        room.players.length !==
        room.maxPlayers
    ){
        return;
    }


    room.started = true;

    room.active = 0;

    room.pendingRolls = [];

    room.canRoll = true;

    room.rank = 1;

    room.finished = false;


    io.to(room.id).emit(
        "gameStart",
        {
            players:
                room.players.map(
                    player=>({
                        id:
                            player.id,

                        name:
                            player.name
                    })
                )
        }
    );


    sendState(room);


    io.to(room.id).emit(
        "systemMessage",
        "Game started!"
    );

}


/* =========================================================
   PUBLIC MATCHMAKING
========================================================= */

function removeFromQueues(socket){

    for(
        const size of [2,3,4]
    ){

        publicQueues[size] =
            publicQueues[size].filter(
                s =>
                    s &&
                    s.connected &&
                    s !== socket
            );

    }

}


function joinGame(
    socket,
    numberOfPlayers
){

    if(
        ![2,3,4].includes(
            numberOfPlayers
        )
    ){

        socket.emit(
            "roomError",
            "Invalid player count."
        );

        return;

    }


    removeFromQueues(socket);


    /*
       Put player into matchmaking queue.
    */

    publicQueues[numberOfPlayers].push(
        socket
    );


    /*
       If enough players are waiting,
       create a room.
    */

    while(
        publicQueues[numberOfPlayers].length >=
        numberOfPlayers
    ){

        const group =
            publicQueues[numberOfPlayers]
                .splice(
                    0,
                    numberOfPlayers
                );


        const roomId =
            `pub_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2,8)}`;


        const room =
            makeRoom(
                roomId,
                numberOfPlayers,
                false
            );


        rooms[roomId]=room;


        group.forEach(
            (playerSocket,index)=>{

                if(
                    !playerSocket ||
                    !playerSocket.connected
                ){
                    return;
                }


                room.sockets.push(
                    playerSocket
                );


                const player =
                    makePlayer(
                        index,
                        playerSocket
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
                        playerId:
                            index,

                        playerName:
                            player.name,

                        roomId:
                            room.id
                    }
                );

            }
        );


        if(
            room.players.length ===
            room.maxPlayers
        ){

            startRoom(room);

        }

    }


    /*
       Tell the player to wait.
    */

    socket.emit(
        "systemMessage",
        "Searching for players..."
    );

}


/* =========================================================
   PRIVATE ROOM
========================================================= */

function createPrivateGame(
    socket,
    numberOfPlayers
){

    if(
        ![2,3,4].includes(
            numberOfPlayers
        )
    ){

        socket.emit(
            "roomError",
            "Invalid player count."
        );

        return;

    }


    let code;

    do{

        code =
            randomCode();

    }while(
        rooms[`private_${code}`]
    );


    const roomId =
        `private_${code}`;


    const room =
        makeRoom(
            roomId,
            numberOfPlayers,
            true
        );


    rooms[roomId]=room;


    room.sockets.push(socket);


    const player =
        makePlayer(
            0,
            socket
        );


    room.players.push(
        player
    );


    socket.join(room.id);


    socket.emit(
        "assignPlayer",
        {
            playerId:0,

            playerName:
                player.name,

            roomId:
                room.id
        }
    );


    socket.emit(
        "privateRoomCreated",
        code
    );


    socket.emit(
        "systemMessage",
        `Private room ${code} created. Waiting for players...`
    );


    sendState(room);

}


function joinPrivateGame(
    socket,
    code
){

    code =
        String(code || "")
            .trim()
            .toUpperCase();


    const room =
        rooms[`private_${code}`];


    if(!room){

        socket.emit(
            "roomError",
            "Room not found."
        );

        return;

    }


    if(
        room.players.length >=
        room.maxPlayers
    ){

        socket.emit(
            "roomError",
            "Room is full."
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


    const playerId =
        room.players.length;


    room.sockets.push(socket);


    const player =
        makePlayer(
            playerId,
            socket
        );


    room.players.push(
        player
    );


    socket.join(room.id);


    socket.emit(
        "assignPlayer",
        {
            playerId:
                playerId,

            playerName:
                player.name,

            roomId:
                room.id
        }
    );


    io.to(room.id).emit(
        "systemMessage",
        `${player.name} joined the room.`
    );


    sendState(room);


    if(
        room.players.length ===
        room.maxPlayers
    ){

        startRoom(room);

    }

}


/* =========================================================
   ROLL
========================================================= */

function handleRoll(socket){

    const room =
        getRoom(socket);


    if(!room){
        return;
    }


    if(!room.started){

        socket.emit(
            "actionError",
            "Waiting for all players..."
        );

        return;

    }


    if(room.finished){

        socket.emit(
            "actionError",
            "Game has finished."
        );

        return;

    }


    const player =
        getPlayer(
            room,
            socket
        );


    if(!player){
        return;
    }


    if(
        room.players[room.active]?.id !==
        player.id
    ){

        socket.emit(
            "actionError",
            "It is not your turn."
        );

        return;

    }


    if(!room.canRoll){

        socket.emit(
            "actionError",
            "Choose a pawn first."
        );

        return;

    }


    const value =
        DICE_VALUES[
            Math.floor(
                Math.random() *
                DICE_VALUES.length
            )
        ];


    const die = {

        id:
            `${Date.now()}_${Math.random()
                .toString(36)
                .slice(2,8)}`,

        value:
            value,

        extraAvailable:
            value === 4 ||
            value === 8

    };


    room.pendingRolls.push(
        die
    );


    player.lastRoll =
        value;


    if(
        value === 4 ||
        value === 8
    ){

        room.canRoll = true;

    }else{

        room.canRoll = false;

    }


    io.to(room.id).emit(
        "diceRolled",
        {
            playerId:
                player.id,

            value:
                value,

            rollId:
                die.id,

            extraAvailable:
                die.extraAvailable

        }
    );


    /*
       If this number cannot move any pawn,
       remove it automatically.
    */

    if(
        !hasValidMove(
            player,
            value
        )
    ){

        setTimeout(
            ()=>{

                const currentRoom =
                    rooms[room.id];

                if(
                    !currentRoom ||
                    currentRoom.finished
                ){
                    return;
                }


                const index =
                    currentRoom.pendingRolls.findIndex(
                        d =>
                            d.id === die.id
                    );


                if(index < 0){
                    return;
                }


                const hadExtra =
                    currentRoom
                        .pendingRolls[index]
                        .extraAvailable;


                currentRoom.pendingRolls.splice(
                    index,
                    1
                );


                if(
                    hadExtra
                ){

                    currentRoom.canRoll=true;

                    sendState(
                        currentRoom
                    );

                    return;

                }


                if(
                    currentRoom.pendingRolls.length
                ){

                    currentRoom.canRoll=false;

                    sendState(
                        currentRoom
                    );

                    return;

                }


                currentRoom.canRoll=false;

                sendState(
                    currentRoom
                );


                setTimeout(
                    ()=>{

                        if(
                            !currentRoom.finished
                        ){

                            nextActive(
                                currentRoom
                            );

                            sendState(
                                currentRoom
                            );

                        }

                    },
                    350
                );

            },
            450
        );

        return;

    }


    sendState(room);

}


/* =========================================================
   MOVE
========================================================= */

function handleMove(
    socket,
    data
){

    const room =
        getRoom(socket);


    if(!room){
        return;
    }


    if(!room.started){

        socket.emit(
            "actionError",
            "Game has not started."
        );

        return;

    }


    if(room.finished){

        socket.emit(
            "actionError",
            "Game has finished."
        );

        return;

    }


    const player =
        getPlayer(
            room,
            socket
        );


    if(!player){
        return;
    }


    const playerId =
        Number(
            data?.playerId
        );


    const pawnIndex =
        Number(
            data?.pawnIndex
        );


    if(
        playerId !== player.id
    ){

        socket.emit(
            "actionError",
            "Invalid player."
        );

        return;

    }


    if(
        room.active !== player.id
    ){

        socket.emit(
            "actionError",
            "It is not your turn."
        );

        return;

    }


    if(
        pawnIndex < 0 ||
        pawnIndex > 3
    ){

        socket.emit(
            "actionError",
            "Invalid pawn."
        );

        return;

    }


    const rollId =
        String(
            data?.rollId || ""
        );


    const rollIndex =
        room.pendingRolls.findIndex(
            die =>
                die.id === rollId
        );


    if(rollIndex < 0){

        socket.emit(
            "actionError",
            "That dice roll is no longer available."
        );

        return;

    }


    const die =
        room.pendingRolls[rollIndex];


    const roll =
        Number(
            die.value
        );


    if(
        !isValidMove(
            player,
            pawnIndex,
            roll
        )
    ){

        socket.emit(
            "actionError",
            "That pawn cannot move with this dice."
        );

        return;

    }


    const from =
        player.pawns[pawnIndex];


    const to =
        from + roll;


    /*
       Remove exactly the selected dice.
    */

    room.pendingRolls.splice(
        rollIndex,
        1
    );


    room.canRoll=false;


    /*
       Move the pawn.
    */

    player.pawns[pawnIndex]=to;


    /*
       Capture only ONE pawn.
    */

    const captured =
        performCapture(
            room,
            player,
            to
        );


    if(captured.length){

        player.hasKilled=true;

    }


    const reachedHome =
        to === 24;


    /*
       Check whether this player
       has moved all four pawns HOME.
    */

    const playerWon =
        checkPlayerWon(
            room,
            player
        );


    /*
       Extra turn:
       - 4
       - 8
       - capture
       - reaching HOME while not yet winning
    */

    let extraTurn = false;


    if(
        die.extraAvailable
    ){

        extraTurn=true;

    }


    if(
        captured.length
    ){

        extraTurn=true;

    }


    if(
        reachedHome &&
        !playerWon
    ){

        extraTurn=true;

    }


    /*
       Check if the game is now finished.
    */

    const finished =
        checkGameFinished(
            room
        );


    if(finished){

        extraTurn=false;

    }else if(extraTurn){

        room.canRoll=true;

    }else if(
        room.pendingRolls.length
    ){

        room.canRoll=false;

    }else{

        /*
           Turn will change after
           client animation.
        */

        room.canRoll=false;

    }


    /*
       Send the movement result.

       playerWon is included so the client
       can show the winning animation.
    */

    io.to(room.id).emit(
        "moveResult",
        {

            playerId:
                playerId,

            pawnIndex:
                pawnIndex,

            from:
                from,

            to:
                to,

            roll:
                roll,

            rollId:
                die.id,

            captured:
                captured,

            extraTurn:
                extraTurn,

            playerWon:
                playerWon,

            finished:
                finished

        }
    );


    /*
       If the game has finished,
       synchronize immediately.
    */

    if(finished){

        sendState(room);

        io.to(room.id).emit(
            "gameFinished"
        );

        return;

    }


    /*
       If another roll is available,
       keep same player.

       Otherwise the turn changes after
       a short delay.
    */

    if(
        extraTurn ||
        room.pendingRolls.length
    ){

        sendState(room);

        return;

    }


    setTimeout(
        ()=>{

            const currentRoom =
                rooms[room.id];

            if(
                !currentRoom ||
                currentRoom.finished
            ){
                return;
            }


            nextActive(
                currentRoom
            );


            sendState(
                currentRoom
            );

        },
        450
    );

}


/* =========================================================
   CHAT
========================================================= */

function handleChat(
    socket,
    data
){

    const room =
        getRoom(socket);


    if(!room){
        return;
    }


    const player =
        getPlayer(
            room,
            socket
        );


    if(!player){
        return;
    }


    let text =
        String(
            data?.text || ""
        )
        .trim();


    if(!text){
        return;
    }


    if(text.length>300){

        text =
            text.slice(
                0,
                300
            );

    }


    /*
       Chat messages ONLY.
       System messages are NOT sent
       through this event.
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


/* =========================================================
   VOICE
========================================================= */

io.on(
    "connection",
    socket=>{

        console.log(
            "Connected:",
            socket.id
        );


        /* -------------------------------------------------
           PUBLIC GAME
        ------------------------------------------------- */

        socket.on(
            "joinGame",
            numberOfPlayers=>{

                joinGame(
                    socket,
                    Number(
                        numberOfPlayers
                    )
                );

            }
        );


        /* -------------------------------------------------
           PRIVATE GAME
        ------------------------------------------------- */

        socket.on(
            "createPrivateGame",
            numberOfPlayers=>{

                createPrivateGame(
                    socket,
                    Number(
                        numberOfPlayers
                    )
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


        /* -------------------------------------------------
           ROLL
        ------------------------------------------------- */

        socket.on(
            "requestRoll",
            ()=>{

                handleRoll(
                    socket
                );

            }
        );


        /* -------------------------------------------------
           MOVE
        ------------------------------------------------- */

        socket.on(
            "requestMove",
            data=>{

                handleMove(
                    socket,
                    data
                );

            }
        );


        /* -------------------------------------------------
           CHAT
        ------------------------------------------------- */

        socket.on(
            "sendChatMessage",
            data=>{

                handleChat(
                    socket,
                    data
                );

            }
        );


        /* -------------------------------------------------
           VOICE JOIN
        ------------------------------------------------- */

        socket.on(
            "voiceJoin",
            ()=>{

                const room =
                    getRoom(socket);


                if(!room){
                    return;
                }


                /*
                   Only connected players are
                   returned as voice peers.
                */

                const peers =
                    room.sockets
                        .filter(
                            other =>
                                other !== socket &&
                                other.connected
                        )
                        .map(
                            other =>
                                other.id
                        );


                socket.emit(
                    "voicePeers",
                    peers
                );

            }
        );


        /* -------------------------------------------------
           VOICE SIGNAL
        ------------------------------------------------- */

        socket.on(
            "voiceSignal",
            data=>{

                const room =
                    getRoom(socket);


                if(!room){
                    return;
                }


                if(
                    !data ||
                    !data.to ||
                    !data.data
                ){
                    return;
                }


                const target =
                    room.sockets.find(
                        other =>
                            other.id ===
                                data.to &&
                            other.connected
                    );


                if(!target){
                    return;
                }


                target.emit(
                    "voiceSignal",
                    {
                        from:
                            socket.id,

                        data:
                            data.data
                    }
                );

            }
        );


        /* -------------------------------------------------
           DISCONNECT
        ------------------------------------------------- */

        socket.on(
            "disconnect",
            ()=>{

                console.log(
                    "Disconnected:",
                    socket.id
                );


                removeFromQueues(
                    socket
                );


                const room =
                    getRoom(socket);


                if(!room){
                    return;
                }


                const leavingPlayer =
                    getPlayer(
                        room,
                        socket
                    );


                /*
                   Remove disconnected socket.
                */

                room.sockets =
                    room.sockets.filter(
                        s =>
                            s !== socket
                    );


                room.players =
                    room.players.filter(
                        player =>
                            player.socketId !==
                            socket.id
                    );


                /*
                   If no players remain,
                   delete room.
                */

                if(
                    room.players.length===0
                ){

                    delete rooms[
                        room.id
                    ];

                    return;

                }


                /*
                   A started game cannot safely
                   keep old numeric player positions
                   after someone leaves.

                   Close the room and notify
                   remaining players.
                */

                if(room.started){

                    room.finished=true;


                    io.to(room.id).emit(
                        "roomClosed",
                        leavingPlayer
                            ? `${leavingPlayer.name} left the game.`
                            : "A player left the game."
                    );


                    delete rooms[
                        room.id
                    ];

                    return;

                }


                /*
                   Private room still waiting.
                */

                if(room.isPrivate){

                    io.to(room.id).emit(
                        "systemMessage",
                        leavingPlayer
                            ? `${leavingPlayer.name} left the room.`
                            : "A player left the room."
                    );

                    sendState(room);

                }

            }
        );

    }
);


/* =========================================================
   SERVER
========================================================= */

const PORT =
    process.env.PORT ||
    3000;


server.listen(
    PORT,
    "0.0.0.0",
    ()=>{
        console.log(
            `Ludo Twist server running on port ${PORT}`
        );
    }
);
