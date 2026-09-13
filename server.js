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

const PORT = process.env.PORT || 3000;

/* =========================================================
   GAME DATA
========================================================= */

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = {};

const FINISH_STEP = 24;

const SAFE_CELLS = new Set([
    2,
    10,
    12,
    14,
    22
]);

const allPlayers = [
    {
        id:0,
        name:"Blue",
        color:"blue",
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
        color:"red",
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
        color:"green",
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
        color:"yellow",
        path:[
            22,23,24,19,14,
            9,4,3,2,1,
            0,5,10,15,20,
            21,16,11,6,7,
            8,13,18,17,12
        ]
    }
];

/* =========================================================
   PLAYER
========================================================= */

function makePlayer(id){

    const info = allPlayers[id];

    return {
        id:id,
        name:info.name,
        color:info.color,

        pawns:[
            0,
            0,
            0,
            0
        ],

        hasKilled:false,
        hasWon:false,
        winRank:null,
        lastRoll:null
    };
}

/* =========================================================
   ROOM
========================================================= */

function makeRoom(id,count,isPrivate=false){

    return {
        id:id,
        maxPlayers:count,
        private:isPrivate,

        sockets:[],
        players:[],

        started:false,

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

/* =========================================================
   HELPERS
========================================================= */

function getRoom(socket){

    if(!socket.gameRoom){
        return null;
    }

    return rooms[socket.gameRoom] || null;
}

function currentPlayer(room){

    return room.players[room.activeIndex];
}

function sendState(room){

    io.to(room.id).emit("gameState",{
        players:room.players,
        activeIndex:room.activeIndex,
        activeRolls:room.activeRolls,
        canRoll:room.canRoll
    });
}

function status(room,text){

    io.to(room.id).emit(
        "statusMessage",
        text
    );
}

function removeFromQueues(socketId){

    for(const count of [2,3,4]){

        publicQueues[count] =
            publicQueues[count].filter(
                id => id !== socketId
            );
    }
}

function generateRoomCode(){

    let code;

    do{

        code =
            Math.random()
            .toString(36)
            .substring(2,8)
            .toUpperCase();

    }while(rooms[code]);

    return code;
}

/* =========================================================
   TURN LOGIC
========================================================= */

function nextActiveIndex(room){

    if(room.players.length === 0){
        return;
    }

    let next =
        room.activeIndex;

    for(let i=0;i<room.players.length;i++){

        next =
            (next + 1) %
            room.players.length;

        if(!room.players[next].hasWon){
            room.activeIndex = next;
            return;
        }
    }
}

function advanceTurn(room){

    room.activeRolls = [];
    room.canRoll = true;

    nextActiveIndex(room);

    const player =
        currentPlayer(room);

    if(player){

        player.lastRoll = null;

        status(
            room,
            `${player.name}'s turn. Roll the dice.`
        );
    }

    sendState(room);
}

/* =========================================================
   VALID MOVES
========================================================= */

function hasValidMove(player,roll){

    return player.pawns.some(
        step =>
            step < FINISH_STEP &&
            step + roll <= FINISH_STEP
    );
}

/* =========================================================
   ROOM SETUP
========================================================= */

function setupRoom(room){

    room.started = true;

    room.players = [];
    room.activeIndex = 0;

    room.sockets.forEach(
        (socket,index)=>{

            socket.playerIndex = index;
            socket.gameRoom = room.id;

            socket.join(room.id);

            const player =
                makePlayer(index);

            room.players.push(player);

            socket.emit(
                "assignPlayer",
                {
                    playerId:index,
                    playerName:player.name
                }
            );
        }
    );

    room.canRoll = true;
    room.activeRolls = [];

    io.to(room.id).emit(
        "gameStart",
        {
            players:room.players,
            activeIndex:0,
            canRoll:true
        }
    );

    status(
        room,
        "Match started! Blue goes first."
    );

    sendState(room);
}

/* =========================================================
   CLOSE ROOM
========================================================= */

function closeRoom(room){

    if(!room) return;

    room.sockets.forEach(socket=>{

        socket.gameRoom = null;
        socket.playerIndex = null;

        socket.leave(room.id);

        socket.emit("roomClosed");
    });

    delete rooms[room.id];
}

/* =========================================================
   CONNECTION
========================================================= */

io.on("connection",socket=>{

    socket.gameRoom = null;
    socket.playerIndex = null;

    console.log(
        "Connected:",
        socket.id
    );

    /* =====================================================
       PUBLIC MATCHMAKING
    ===================================================== */

    socket.on("joinGame",count=>{

        count =
            Number(count);

        if(![2,3,4].includes(count)){

            socket.emit(
                "roomError",
                "Invalid player count."
            );

            return;
        }

        removeFromQueues(
            socket.id
        );

        publicQueues[count].push(
            socket.id
        );

        socket.emit(
            "statusMessage",
            `Waiting for ${count} players...`
        );

        if(
            publicQueues[count].length >= count
        ){

            const socketIds =
                publicQueues[count]
                .splice(0,count);

            const roomId =
                "pub_" +
                Math.random()
                .toString(36)
                .substring(2,10);

            const room =
                makeRoom(
                    roomId,
                    count,
                    false
                );

            rooms[roomId] = room;

            socketIds.forEach(id=>{

                const s =
                    io.sockets.sockets.get(id);

                if(s){
                    room.sockets.push(s);
                }
            });

            if(room.sockets.length === count){

                setupRoom(room);

            }else{

                delete rooms[roomId];
            }
        }
    });

    /* =====================================================
       PRIVATE CREATE
    ===================================================== */

    socket.on(
        "createPrivateGame",
        count=>{

            count =
                Number(count);

            if(![2,3,4].includes(count)){

                socket.emit(
                    "roomError",
                    "Invalid player count."
                );

                return;
            }

            const code =
                generateRoomCode();

            const room =
                makeRoom(
                    code,
                    count,
                    true
                );

            rooms[code] = room;

            room.sockets.push(socket);

            socket.gameRoom = code;
            socket.playerIndex = null;

            socket.join(code);

            socket.emit(
                "privateRoomCreated",
                {
                    code:code
                }
            );

            socket.emit(
                "statusMessage",
                `Room ${code} created. Waiting for players...`
            );
        }
    );

    /* =====================================================
       PRIVATE JOIN
    ===================================================== */

    socket.on(
        "joinPrivateGame",
        code=>{

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
                    "Game has already started."
                );

                return;
            }

            if(
                room.sockets.length >=
                room.maxPlayers
            ){

                socket.emit(
                    "roomError",
                    "Room is full."
                );

                return;
            }

            room.sockets.push(socket);

            socket.gameRoom = code;
            socket.playerIndex = null;

            socket.join(code);

            socket.emit(
                "statusMessage",
                "Joined room. Waiting for all players..."
            );

            if(
                room.sockets.length ===
                room.maxPlayers
            ){

                setupRoom(room);
            }
        }
    );

    /* =====================================================
       ROLL
    ===================================================== */

    socket.on(
        "requestRoll",
        ()=>{

            const room =
                getRoom(socket);

            if(!room || !room.started){
                return;
            }

            const player =
                currentPlayer(room);

            if(!player){
                return;
            }

            if(
                socket.playerIndex !==
                player.id
            ){
                return;
            }

            if(!room.canRoll){
                return;
            }

            if(room.activeRolls.length){
                return;
            }

            /*
             * 4 and 8 are special rolls.
             */
            const values = [
                1,1,
                2,2,
                3,3,
                4,4,
                8
            ];

            const roll =
                values[
                    Math.floor(
                        Math.random() *
                        values.length
                    )
                ];

            room.canRoll = false;

            room.activeRolls.push(
                roll
            );

            room.diceValues[player.id] =
                roll;

            player.lastRoll =
                roll;

            io.to(room.id).emit(
                "diceRolled",
                {
                    playerId:player.id,
                    playerName:player.name,
                    roll:roll
                }
            );

            /*
             * No valid move.
             */
            if(!hasValidMove(player,roll)){

                room.activeRolls.shift();

                if(
                    roll === 4 ||
                    roll === 8
                ){

                    /*
                     * SAME PLAYER AGAIN.
                     */
                    room.canRoll = true;

                    status(
                        room,
                        `${player.name} rolled ${roll}. Extra roll!`
                    );

                    sendState(room);

                }else{

                    advanceTurn(room);
                }

                return;
            }

            status(
                room,
                `${player.name} rolled ${roll}. Choose a pawn.`
            );

            sendState(room);
        }
    );

    /* =====================================================
       MOVE
    ===================================================== */

    socket.on(
        "requestMove",
        data=>{

            const room =
                getRoom(socket);

            if(!room || !room.started){
                return;
            }

            const playerId =
                Number(data.playerId);

            const pawnIndex =
                Number(data.pawnIndex);

            const player =
                currentPlayer(room);

            if(!player){
                return;
            }

            if(
                socket.playerIndex !==
                playerId
            ){
                return;
            }

            if(player.id !== playerId){
                return;
            }

            if(
                !Number.isInteger(pawnIndex) ||
                pawnIndex < 0 ||
                pawnIndex > 3
            ){
                return;
            }

            if(
                room.activeRolls.length === 0
            ){
                return;
            }

            const roll =
                room.activeRolls[0];

            const oldStep =
                player.pawns[pawnIndex];

            const newStep =
                oldStep + roll;

            if(
                oldStep >= FINISH_STEP ||
                newStep > FINISH_STEP
            ){
                return;
            }

            /*
             * Consume the roll.
             */
            room.activeRolls.shift();

            player.pawns[pawnIndex] =
                newStep;

            player.lastRoll = null;

            const targetCell =
                allPlayers[player.id]
                .path[newStep];

            let captured = false;

            /* =============================================
               CAPTURE
            ============================================= */

            if(
                newStep < FINISH_STEP &&
                !SAFE_CELLS.has(targetCell)
            ){

                room.players.forEach(
                    opponent=>{

                        if(
                            opponent.id ===
                            player.id
                        ){
                            return;
                        }

                        opponent.pawns =
                            opponent.pawns.map(
                                step=>{

                                    if(
                                        step > 0 &&
                                        step < FINISH_STEP &&
                                        allPlayers[
                                            opponent.id
                                        ].path[step]
                                        === targetCell
                                    ){

                                        captured = true;

                                        return 0;
                                    }

                                    return step;
                                }
                            );
                    }
                );
            }

            if(captured){

                player.hasKilled = true;
            }

            /* =============================================
               WIN
            ============================================= */

            if(
                player.pawns.every(
                    step =>
                        step === FINISH_STEP
                )
            ){

                player.hasWon = true;
                player.winRank =
                    room.currentRank++;

                room.canRoll = false;

                io.to(room.id).emit(
                    "moveResult",
                    {
                        playerId:player.id,
                        pawnIndex:pawnIndex,
                        pawns:player.pawns,
                        captured:captured
                    }
                );

                sendState(room);

                io.to(room.id).emit(
                    "gameFinished",
                    {
                        name:player.name,
                        playerId:player.id
                    }
                );

                return;
            }

            /* =============================================
               EXTRA TURN
            ============================================= */

            const extraTurn =
                roll === 4 ||
                roll === 8 ||
                captured;

            io.to(room.id).emit(
                "moveResult",
                {
                    playerId:player.id,
                    pawnIndex:pawnIndex,
                    pawns:player.pawns,
                    captured:captured
                }
            );

            if(extraTurn){

                /*
                 * CRITICAL FIX:
                 * DO NOT change activeIndex.
                 */
                room.canRoll = true;

                room.activeRolls = [];

                status(
                    room,
                    captured
                    ? `${player.name} captured a pawn. Extra roll!`
                    : `${player.name} gets another roll!`
                );

                sendState(room);

                return;
            }

            /* =============================================
               NORMAL NEXT TURN
            ============================================= */

            advanceTurn(room);
        }
    );

    /* =====================================================
       CHAT
    ===================================================== */

    socket.on(
        "sendChatMessage",
        message=>{

            const room =
                getRoom(socket);

            if(!room){
                return;
            }

            const player =
                room.players[
                    socket.playerIndex
                ];

            if(!player){
                return;
            }

            const cleanMessage =
                String(message)
                .trim()
                .substring(0,300);

            if(!cleanMessage){
                return;
            }

            /*
             * ONLY actual player messages are sent
             * to receiveChatMessage.
             *
             * No system messages go into chat.
             */
            io.to(room.id).emit(
                "receiveChatMessage",
                {
                    name:player.name,
                    message:cleanMessage
                }
            );
        }
    );

    /* =====================================================
       VOICE / WEBRTC RELAY
    ===================================================== */

    socket.on(
        "voiceOffer",
        data=>{

            const room =
                getRoom(socket);

            if(!room) return;

            const target =
                io.sockets.sockets.get(
                    data.targetId
                );

            if(target){

                target.emit(
                    "voiceOffer",
                    {
                        fromId:socket.id,
                        offer:data.offer
                    }
                );
            }
        }
    );

    socket.on(
        "voiceAnswer",
        data=>{

            const target =
                io.sockets.sockets.get(
                    data.targetId
                );

            if(target){

                target.emit(
                    "voiceAnswer",
                    {
                        fromId:socket.id,
                        answer:data.answer
                    }
                );
            }
        }
    );

    socket.on(
        "iceCandidate",
        data=>{

            const target =
                io.sockets.sockets.get(
                    data.targetId
                );

            if(target){

                target.emit(
                    "iceCandidate",
                    {
                        fromId:socket.id,
                        candidate:data.candidate
                    }
                );
            }
        }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
        "disconnect",
        ()=>{

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
                 * For now, close the match when a player
                 * leaves so no broken game state remains.
                 */
                closeRoom(room);
            }
        }
    );
});

/* =========================================================
   SERVER START
========================================================= */

server.listen(
    PORT,
    ()=>{
        console.log(
            `Ludo Twist server running on port ${PORT}`
        );
    }
);
