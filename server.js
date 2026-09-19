const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;


/* =========================================================
   GAME CONSTANTS
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
        10,15,20,21,22,23,24,19,14,9,
        4,3,2,1,0,5,6,7,8,13,
        18,17,16,11,12
    ],

    [
        2,1,0,5,10,15,20,21,22,23,
        24,19,14,9,4,3,8,13,18,17,
        16,11,6,7,12
    ],

    [
        14,9,4,3,2,1,0,5,10,15,
        20,21,22,23,24,19,18,17,16,11,
        6,7,8,13,12
    ],

    [
        22,23,24,19,14,9,4,3,2,1,
        0,5,10,15,20,21,16,11,6,7,
        8,13,18,17,12
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
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    8
];


/* =========================================================
   ROOMS / QUEUES
========================================================= */

const queues = {
    2: [],
    3: [],
    4: []
};

const rooms = new Map();


/* =========================================================
   PLAYER
========================================================= */

function makePlayer(
    socketId,
    index
){

    return {

        id: socketId,

        index,

        name: NAMES[index],

        color: COLORS[index],

        pawns: [
            0,
            0,
            0,
            0
        ],

        hasKilled: false,

        finished: false,

        lastRoll: null
    };
}


/* =========================================================
   ROOM
========================================================= */

function makeRoom(
    id,
    mode,
    maxPlayers
){

    return {

        id,

        mode,

        maxPlayers,

        players: [],

        started: false,

        currentIndex: 0,

        rolls: new Map(),

        finished: false
    };
}


/* =========================================================
   STATE
========================================================= */

function publicPlayer(player){

    return {

        id: player.id,

        index: player.index,

        name: player.name,

        color: player.color,

        pawns: [
            ...player.pawns
        ],

        hasKilled:
            player.hasKilled,

        finished:
            player.finished,

        lastRoll:
            player.lastRoll
    };
}


function getPublicState(room){

    const currentPlayer =
        room.players[
            room.currentIndex
        ];

    return {

        roomId: room.id,

        mode: room.mode,

        maxPlayers:
            room.maxPlayers,

        started:
            room.started,

        currentIndex:
            room.currentIndex,

        currentPlayerId:
            currentPlayer
            ? currentPlayer.id
            : null,

        canRoll:
            room.started &&
            !!currentPlayer &&
            !currentPlayer.finished &&
            !room.rolls.has(
                currentPlayer.id
            ),

        players:
            room.players.map(
                publicPlayer
            )
    };
}


function sendState(room){

    io.to(room.id).emit(
        "gameState",
        getPublicState(room)
    );
}


function sendMessage(
    room,
    message
){

    io.to(room.id).emit(
        "systemMessage",
        message
    );
}


/* =========================================================
   ROOM LOOKUP
========================================================= */

function findRoomByPlayer(
    socketId
){

    for(
        const room of rooms.values()
    ){

        if(
            room.players.some(
                p=>p.id===socketId
            )
        ){

            return room;
        }
    }

    return null;
}


/* =========================================================
   QUEUE
========================================================= */

function removeFromAllQueues(
    socketId
){

    for(
        const count of [2,3,4]
    ){

        queues[count]=
            queues[count].filter(
                id=>id!==socketId
            );
    }
}


/* =========================================================
   PUBLIC MATCHMAKING
========================================================= */

function joinPublicGame(
    socket,
    count
){

    count=Number(count);

    if(
        ![2,3,4].includes(count)
    ){

        socket.emit(
            "roomError",
            "Invalid player count."
        );

        return;
    }


    /* Remove from another queue */

    removeFromAllQueues(
        socket.id
    );


    /* Already in a room */

    const oldRoom=
        findRoomByPlayer(
            socket.id
        );

    if(oldRoom){

        socket.emit(
            "roomError",
            "You are already in a game."
        );

        return;
    }


    /* Put player in requested queue */

    queues[count].push(
        socket.id
    );


    /* Remove dead sockets */

    queues[count]=
        queues[count].filter(
            id=>
                io.sockets.sockets.has(id)
        );


    /*
       IMPORTANT:
       Build a complete room only when
       count players are available.
    */

    if(
        queues[count].length <
        count
    ){

        socket.emit(
            "waiting",
            `Waiting for ${count} players...`
        );

        return;
    }


    const selected=[];

    while(
        selected.length<count &&
        queues[count].length
    ){

        const id=
            queues[count].shift();

        if(
            io.sockets.sockets.has(id)
        ){

            selected.push(id);
        }
    }


    if(
        selected.length<count
    ){

        for(
            const id of selected
        ){

            queues[count].unshift(id);
        }

        socket.emit(
            "waiting",
            `Waiting for ${count} players...`
        );

        return;
    }


    const roomId =
        `public_${count}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2,8)}`;


    const room=
        makeRoom(
            roomId,
            "public",
            count
        );

    rooms.set(
        room.id,
        room
    );


    selected.forEach(
        (socketId,index)=>{

            const playerSocket =
                io.sockets.sockets.get(
                    socketId
                );

            if(!playerSocket){
                return;
            }

            const player=
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
                    playerId:
                        player.id,

                    index:
                        player.index,

                    name:
                        player.name,

                    color:
                        player.color
                }
            );
        }
    );


    if(
        room.players.length===
        room.maxPlayers
    ){

        startRoom(room);
    }
}


/* =========================================================
   PRIVATE ROOM
========================================================= */

function createPrivateGame(
    socket,
    count
){

    count=Number(count);

    if(
        ![2,3,4].includes(count)
    ){

        socket.emit(
            "roomError",
            "Invalid player count."
        );

        return;
    }


    removeFromAllQueues(
        socket.id
    );


    const existing=
        findRoomByPlayer(
            socket.id
        );

    if(existing){

        socket.emit(
            "roomError",
            "You are already in a game."
        );

        return;
    }


    let code;

    do{

        code=
            Math.random()
                .toString(36)
                .slice(2,8)
                .toUpperCase();

    }while(
        [...rooms.values()]
            .some(
                room=>
                    room.code===code
            )
    );


    const room=
        makeRoom(
            `private_${code}`,
            "private",
            count
        );

    room.code=code;

    rooms.set(
        room.id,
        room
    );


    const player=
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
            playerId:
                player.id,

            index:
                player.index,

            name:
                player.name,

            color:
                player.color
        }
    );


    socket.emit(
        "privateRoomCreated",
        {
            code,
            players:
                room.players.length,
            maxPlayers:
                room.maxPlayers
        }
    );


    sendState(room);
}


function joinPrivateGame(
    socket,
    rawCode
){

    const code=
        String(rawCode || "")
            .trim()
            .toUpperCase();


    const room=
        [...rooms.values()]
            .find(
                r=>
                    r.mode==="private" &&
                    r.code===code
            );


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
        room.players.length >=
        room.maxPlayers
    ){

        socket.emit(
            "roomError",
            "Room is full."
        );

        return;
    }


    const index=
        room.players.length;


    const player=
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
            playerId:
                player.id,

            index:
                player.index,

            name:
                player.name,

            color:
                player.color
        }
    );


    sendMessage(
        room,
        `${player.name} joined the room.`
    );


    sendState(room);


    if(
        room.players.length===
        room.maxPlayers
    ){

        startRoom(room);
    }
}


/* =========================================================
   START
========================================================= */

function startRoom(room){

    if(
        room.players.length !==
        room.maxPlayers
    ){

        return;
    }


    room.started=true;

    room.finished=false;

    room.currentIndex=0;

    room.rolls.clear();


    for(
        const player of room.players
    ){

        player.pawns=[
            0,
            0,
            0,
            0
        ];

        player.hasKilled=false;

        player.finished=false;

        player.lastRoll=null;
    }


    io.to(room.id).emit(
        "gameStart",
        getPublicState(room)
    );


    sendState(room);


    sendMessage(
        room,
        `${room.players[0].name}'s turn`
    );
}


/* =========================================================
   TURN
========================================================= */

function nextTurn(room){

    if(
        !room.players.length
    ){

        return;
    }


    const total=
        room.players.length;


    for(
        let offset=1;
        offset<=total;
        offset++
    ){

        const next=
            (room.currentIndex+
             offset) %
            total;


        const player=
            room.players[next];


        if(
            player &&
            !player.finished
        ){

            room.currentIndex=
                next;

            return;
        }
    }
}


/* =========================================================
   MOVE VALIDATION
========================================================= */

function isValidMove(
    player,
    pawnIndex,
    roll
){

    if(!player){
        return false;
    }


    if(
        pawnIndex<0 ||
        pawnIndex>3
    ){

        return false;
    }


    const step=
        player.pawns[pawnIndex];


    if(step>=24){
        return false;
    }


    /*
       Before the first capture,
       a pawn can move only up to 15.

       After a capture, it can continue
       toward HOME.
    */

    const maximum=
        player.hasKilled
        ? 24
        : 15;


    return (
        step+
        roll<=
        maximum
    );
}


/* =========================================================
   CAPTURE
========================================================= */

function performCapture(
    room,
    player,
    toStep
){

    if(toStep>=24){
        return false;
    }


    const boardCell=
        PATHS[
            player.index
        ][toStep];


    if(
        SAFE.includes(
            boardCell
        )
    ){

        return false;
    }


    let captured=false;


    for(
        const opponent of room.players
    ){

        if(
            opponent.index===
            player.index
        ){

            continue;
        }


        for(
            let i=0;
            i<opponent.pawns.length;
            i++
        ){

            const opponentStep=
                opponent.pawns[i];


            if(
                opponentStep>0 &&
                opponentStep<24 &&
                PATHS[
                    opponent.index
                ][opponentStep]===
                boardCell
            ){

                opponent.pawns[i]=0;

                captured=true;
            }
        }
    }


    if(captured){

        player.hasKilled=true;
    }


    return captured;
}


/* =========================================================
   ROLL
========================================================= */

function requestRoll(
    socket
){

    const room=
        findRoomByPlayer(
            socket.id
        );


    if(
        !room ||
        !room.started
    ){

        return;
    }


    const player=
        room.players[
            room.currentIndex
        ];


    if(
        !player ||
        player.id!==socket.id
    ){

        socket.emit(
            "actionError",
            "It is not your turn."
        );

        return;
    }


    if(
        player.finished
    ){

        return;
    }


    /*
       A player can only have one
       unresolved dice roll.
    */

    if(
        room.rolls.has(
            socket.id
        )
    ){

        socket.emit(
            "actionError",
            "Choose a pawn first."
        );

        return;
    }


    const value=
        DICE_VALUES[
            Math.floor(
                Math.random()*
                DICE_VALUES.length
            )
        ];


    const rollId=
        `${Date.now()}_${Math.random()
            .toString(36)
            .slice(2,8)}`;


    room.rolls.set(
        socket.id,
        {
            id:rollId,
            value
        }
    );


    player.lastRoll=value;


    io.to(room.id).emit(
        "diceRolled",
        {
            playerId:
                player.id,

            playerIndex:
                player.index,

            name:
                player.name,

            value,

            rollId
        }
    );


    const validMoves=[];


    for(
        let i=0;
        i<4;
        i++
    ){

        if(
            isValidMove(
                player,
                i,
                value
            )
        ){

            validMoves.push(i);
        }
    }


    /*
       No valid move.
       4/8 still gives another roll.
    */

    if(
        validMoves.length===0
    ){

        room.rolls.delete(
            socket.id
        );


        const extra=
            value===4 ||
            value===8;


        setTimeout(()=>{

            if(
                !room.started ||
                !rooms.has(room.id)
            ){

                return;
            }


            if(extra){

                io.to(room.id).emit(
                    "extraTurn",
                    {
                        playerId:
                            player.id,

                        reason:
                            "Extra roll"
                    }
                );


                sendMessage(
                    room,
                    `${player.name} gets another roll.`
                );


                sendState(room);

            }else{

                nextTurn(room);

                sendState(room);

                sendMessage(
                    room,
                    `${room.players[room.currentIndex].name}'s turn`
                );
            }

        },850);
    }
}


/* =========================================================
   MOVE
========================================================= */

function requestMove(
    socket,
    data
){

    const room=
        findRoomByPlayer(
            socket.id
        );


    if(
        !room ||
        !room.started
    ){

        return;
    }


    const player=
        room.players.find(
            p=>p.id===socket.id
        );


    if(!player){
        return;
    }


    if(
        room.currentIndex !==
        player.index
    ){

        socket.emit(
            "actionError",
            "It is not your turn."
        );

        return;
    }


    const storedRoll=
        room.rolls.get(
            socket.id
        );


    if(!storedRoll){

        socket.emit(
            "actionError",
            "Roll the dice first."
        );

        return;
    }


    const rollId=
        String(
            data?.rollId || ""
        );


    if(
        storedRoll.id !==
        rollId
    ){

        socket.emit(
            "actionError",
            "That dice roll is no longer valid."
        );

        return;
    }


    const pawnIndex=
        Number(
            data?.pawnIndex
        );


    const roll=
        Number(
            storedRoll.value
        );


    if(
        !Number.isInteger(
            pawnIndex
        ) ||
        pawnIndex<0 ||
        pawnIndex>3
    ){

        socket.emit(
            "actionError",
            "Invalid pawn."
        );

        return;
    }


    if(
        !isValidMove(
            player,
            pawnIndex,
            roll
        )
    ){

        socket.emit(
            "actionError",
            "That pawn cannot move."
        );

        return;
    }


    const oldStep=
        player.pawns[pawnIndex];


    const newStep=
        oldStep+roll;


    player.pawns[pawnIndex]=
        newStep;


    room.rolls.delete(
        socket.id
    );


    const captured=
        performCapture(
            room,
            player,
            newStep
        );


    const reachedHome=
        newStep>=24;


    if(reachedHome){

        player.pawns[pawnIndex]=24;
    }


    const won=
        player.pawns.every(
            pawn=>pawn>=24
        );


    io.to(room.id).emit(
        "moveResult",
        {
            playerId:
                player.id,

            playerIndex:
                player.index,

            pawnIndex,

            oldStep,

            newStep:
                player.pawns[pawnIndex],

            roll,

            captured,

            reachedHome
        }
    );


    sendState(room);


    if(won){

        player.finished=true;


        io.to(room.id).emit(
            "playerFinished",
            {
                playerId:
                    player.id,

                playerIndex:
                    player.index,

                name:
                    player.name
            }
        );


        io.to(room.id).emit(
            "gameWinner",
            {
                playerId:
                    player.id,

                playerIndex:
                    player.index,

                name:
                    player.name
            }
        );


        sendState(room);


        /*
           The finished player remains in the room.
           Other players can continue until only
           one unfinished player remains.
        */

        const remaining=
            room.players.filter(
                p=>!p.finished
            );


        if(
            remaining.length<=1
        ){

            room.finished=true;

            if(
                remaining.length===1
            ){

                const last=
                    remaining[0];

                last.finished=true;

                io.to(room.id).emit(
                    "playerFinished",
                    {
                        playerId:
                            last.id,

                        playerIndex:
                            last.index,

                        name:
                            last.name
                    }
                );
            }

            sendState(room);

            return;
        }


        /*
           Winner receives no automatic extra
           turn after finishing.
        */

        setTimeout(()=>{

            if(
                !rooms.has(room.id) ||
                room.finished
            ){

                return;
            }

            nextTurn(room);

            sendState(room);

            sendMessage(
                room,
                `${room.players[room.currentIndex].name}'s turn`
            );

        },850);

        return;
    }


    const extra=
        roll===4 ||
        roll===8 ||
        captured ||
        reachedHome;


    setTimeout(()=>{

        if(
            !rooms.has(room.id) ||
            !room.started
        ){

            return;
        }


        if(extra){

            io.to(room.id).emit(
                "extraTurn",
                {
                    playerId:
                        player.id,

                    reason:
                        captured
                        ? "Capture"
                        : reachedHome
                        ? "HOME"
                        : "Extra roll"
                }
            );


            sendMessage(
                room,
                `${player.name} gets another roll.`
            );


            sendState(room);

        }else{

            nextTurn(room);

            sendState(room);

            sendMessage(
                room,
                `${room.players[room.currentIndex].name}'s turn`
            );
        }

    },850);
}


/* =========================================================
   CHAT
========================================================= */

function sendChatMessage(
    socket,
    text
){

    const room=
        findRoomByPlayer(
            socket.id
        );


    if(!room){
        return;
    }


    const player=
        room.players.find(
            p=>p.id===socket.id
        );


    if(!player){
        return;
    }


    const message=
        String(text || "")
            .trim()
            .slice(0,150);


    if(!message){
        return;
    }


    /*
       IMPORTANT:
       Chat messages use receiveChatMessage.

       System messages NEVER go through this
       event, so server/system messages do not
       appear in the chat box.
    */

    io.to(room.id).emit(
        "receiveChatMessage",
        {
            playerId:
                player.id,

            name:
                player.name,

            color:
                player.color,

            message
        }
    );
}


/* =========================================================
   VOICE
========================================================= */

function voiceJoin(socket){

    const room=
        findRoomByPlayer(
            socket.id
        );


    if(!room){
        return;
    }


    socket.to(room.id).emit(
        "voiceUserJoined",
        {
            playerId:
                socket.id
        }
    );
}


function voiceSignal(
    socket,
    data
){

    if(
        !data ||
        !data.target ||
        !data.signal
    ){

        return;
    }


    const room=
        findRoomByPlayer(
            socket.id
        );


    if(!room){
        return;
    }


    const target=
        room.players.find(
            p=>p.id===data.target
        );


    if(!target){
        return;
    }


    io.to(
        target.id
    ).emit(
        "voiceSignal",
        {
            from:
                socket.id,

            signal:
                data.signal
        }
    );
}


/* =========================================================
   LEAVE
========================================================= */

function closeRoom(
    room,
    message
){

    if(!room)return;

    rooms.delete(
        room.id
    );

    io.to(room.id).emit(
        "roomClosed",
        message || "Room closed."
    );
}


/* =========================================================
   CONNECTION
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
            count=>{
                joinPublicGame(
                    socket,
                    count
                );
            }
        );


        /*
           Backward-compatible alias.
           If an older client sends joinGame,
           it still works.
        */

        socket.on(
            "joinGame",
            count=>{
                joinPublicGame(
                    socket,
                    count
                );
            }
        );


        socket.on(
            "createPrivateGame",
            count=>{
                createPrivateGame(
                    socket,
                    count
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
                requestRoll(
                    socket
                );
            }
        );


        socket.on(
            "requestMove",
            data=>{
                requestMove(
                    socket,
                    data
                );
            }
        );


        socket.on(
            "sendChatMessage",
            text=>{
                sendChatMessage(
                    socket,
                    text
                );
            }
        );


        socket.on(
            "voiceJoin",
            ()=>{
                voiceJoin(
                    socket
                );
            }
        );


        socket.on(
            "voiceSignal",
            data=>{
                voiceSignal(
                    socket,
                    data
                );
            }
        );


        socket.on(
            "leaveRoom",
            ()=>{

                removeFromAllQueues(
                    socket.id
                );

                const room=
                    findRoomByPlayer(
                        socket.id
                    );


                if(room){

                    closeRoom(
                        room,
                        "The room was closed."
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


                removeFromAllQueues(
                    socket.id
                );


                const room=
                    findRoomByPlayer(
                        socket.id
                    );


                if(room){

                    /*
                       For a simple synchronized
                       game, close the room if a
                       player disconnects rather
                       than leaving the remaining
                       clients with an invalid turn.
                    */

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
   SERVER
========================================================= */

server.listen(
    PORT,
    ()=>{
        console.log(
            `Ludo Twist running on port ${PORT}`
        );
    }
);
