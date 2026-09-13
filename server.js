const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();

const server =
    http.createServer(app);

const io =
    new Server(server,{
        cors:{
            origin:"*"
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

const COLORS=[
    '#1e90ff',
    '#ff4757',
    '#2ed573',
    '#ffa502'
];

const NAMES=[
    'Blue',
    'Red',
    'Green',
    'Yellow'
];

const PATHS=[

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

const SAFE=[
    2,
    10,
    12,
    14,
    22
];

const DICE_VALUES=[
    1,1,
    2,2,
    3,3,
    4,
    8
];


/* =========================================================
   QUEUES
========================================================= */

const queues={
    2:[],
    3:[],
    4:[]
};

const rooms=
    new Map();


/* =========================================================
   PLAYER
========================================================= */

function makePlayer(id){

    return{

        id:id,

        name:NAMES[id],

        color:COLORS[id],

        pawns:[
            0,0,0,0
        ],

        hasKilled:false,

        hasWon:false,

        rank:0,

        lastRoll:null

    };

}


/* =========================================================
   ROOM
========================================================= */

function makeRoom(
    id,
    maxPlayers,
    isPrivate
){

    return{

        id:id,

        maxPlayers:maxPlayers,

        isPrivate:isPrivate,

        sockets:[],

        players:[],

        started:false,

        finished:false,

        active:0,

        /*
           Multiple stored dice.
        */

        pendingRolls:[],

        /*
           Index of the dice whose
           4/8 extra-roll permission
           is currently available.

           -1 means no dice-specific
           permission.
        */

        rollPermissionIndex:-1,

        /*
           Extra roll from capture/HOME
           is not tied to a dice.
        */

        canRoll:true,

        rank:1

    };

}


/* =========================================================
   HELPERS
========================================================= */

function getRoom(socket){

    const roomId=
        socket.data.roomId;

    if(!roomId)
        return null;

    return rooms.get(roomId)||null;

}


function getCurrentPlayer(room){

    if(
        !room ||
        !room.players.length
    )
        return null;

    return room.players[
        room.active
    ];

}


function removeFromQueues(socketId){

    for(
        const count of [2,3,4]
    ){

        queues[count]=
            queues[count].filter(
                s=>
                    s &&
                    s.id!==socketId
            );

    }

}


function makeRoomCode(){

    let code;

    do{

        code=
            Math.random()
            .toString(36)
            .slice(2,8)
            .toUpperCase();

    }while(
        rooms.has(code)
    );

    return code;

}


/* =========================================================
   NEXT PLAYER
========================================================= */

function nextActive(room){

    if(
        !room ||
        !room.players.length
    )
        return 0;

    for(
        let step=1;
        step<=room.players.length;
        step++
    ){

        const index=
            (
                room.active+
                step
            )%
            room.players.length;

        const player=
            room.players[index];

        if(
            player &&
            !player.hasWon
        ){

            return index;

        }

    }

    return room.active;

}


/* =========================================================
   MOVEMENT
========================================================= */

function isValidMove(
    player,
    pawnIndex,
    roll
){

    if(!player)
        return false;

    if(player.hasWon)
        return false;

    if(
        !Number.isInteger(pawnIndex)
    )
        return false;

    if(
        pawnIndex<0 ||
        pawnIndex>3
    )
        return false;

    const step=
        Number(
            player.pawns[pawnIndex]
        );

    if(step>=24)
        return false;

    const destination=
        step+
        Number(roll);

    const maximum=
        player.hasKilled
        ?24
        :15;

    return destination<=maximum;

}


function hasValidMove(
    player,
    roll
){

    return player.pawns.some(
        (_,i)=>
            isValidMove(
                player,
                i,
                roll
            )
    );

}


/* =========================================================
   STATE
========================================================= */

function getPublicState(room){

    return{

        active:
            room.active,

        pendingRolls:
            room.pendingRolls.map(
                r=>({
                    value:r.value,
                    extraUsed:
                        r.extraUsed
                })
            ),

        rollPermissionIndex:
            room.rollPermissionIndex,

        canRoll:
            room.canRoll,

        rank:
            room.rank,

        finished:
            room.finished,

        players:
            room.players.map(
                p=>({

                    id:p.id,

                    name:p.name,

                    color:p.color,

                    pawns:[
                        ...p.pawns
                    ],

                    hasKilled:
                        p.hasKilled,

                    hasWon:
                        p.hasWon,

                    rank:
                        p.rank,

                    lastRoll:
                        p.lastRoll

                })
            )

    };

}


function sendState(room){

    if(!room)
        return;

    io.to(room.id).emit(
        'gameState',
        getPublicState(room)
    );

}


function sendMessage(
    room,
    message
){

    if(!room)
        return;

    io.to(room.id).emit(
        'systemMessage',
        message
    );

}


/* =========================================================
   FINISH CHECK
========================================================= */

function checkGameFinished(room){

    const remaining=
        room.players.filter(
            p=>!p.hasWon
        );

    if(
        remaining.length<=1
    ){

        if(
            remaining.length===1
        ){

            const last=
                remaining[0];

            last.hasWon=true;

            last.rank=
                room.rank++;

        }

        room.finished=true;

        room.canRoll=false;

        room.pendingRolls=[];

        room.rollPermissionIndex=-1;

        return true;

    }

    return false;

}


/* =========================================================
   START ROOM
========================================================= */

function startRoom(
    roomId,
    sockets
){

    const room=
        rooms.get(roomId);

    if(!room)
        return;

    room.sockets=[
        ...sockets
    ];

    room.players=[];

    room.started=true;

    room.finished=false;

    room.active=0;

    room.pendingRolls=[];

    room.rollPermissionIndex=-1;

    room.canRoll=true;

    room.rank=1;


    sockets.forEach(
        (socket,index)=>{

            const playerId=
                index;

            socket.data.roomId=
                roomId;

            socket.data.playerId=
                playerId;

            socket.join(roomId);

            room.players.push(
                makePlayer(
                    playerId
                )
            );

            socket.emit(
                'assignPlayer',
                {
                    playerId:
                        playerId,

                    playerName:
                        NAMES[playerId]
                }
            );

        }
    );


    io.to(roomId).emit(
        'gameStart',
        {
            players:
                room.players.map(
                    p=>p.id
                )
        }
    );


    sendMessage(
        room,
        '🎮 Match started! Blue goes first.'
    );

    sendState(room);

}


/* =========================================================
   CLOSE ROOM
========================================================= */

function closeRoom(
    roomId,
    message
){

    const room=
        rooms.get(roomId);

    if(!room)
        return;

    io.to(roomId).emit(
        'roomClosed',
        message ||
        'Room closed.'
    );

    room.sockets.forEach(
        socket=>{

            socket.leave(roomId);

            socket.data.roomId=null;

            socket.data.playerId=null;

        }
    );

    rooms.delete(roomId);

}


/* =========================================================
   CONNECTION
========================================================= */

io.on(
    'connection',
    socket=>{

        console.log(
            'Connected:',
            socket.id
        );


        /* =================================================
           PUBLIC GAME
        ================================================= */

        socket.on(
            'joinGame',
            numberOfPlayers=>{

                const count=
                    Number(
                        numberOfPlayers
                    );

                if(
                    ![2,3,4].includes(count)
                ){

                    socket.emit(
                        'roomError',
                        'Invalid player count.'
                    );

                    return;

                }

                removeFromQueues(
                    socket.id
                );

                queues[count].push(
                    socket
                );

                socket.emit(
                    'systemMessage',
                    `Waiting for ${
                        count-
                        queues[count].length
                    } more player(s)...`
                );

                if(
                    queues[count].length>=count
                ){

                    const matched=
                        queues[count]
                        .splice(
                            0,
                            count
                        );

                    const roomId=
                        'pub_'+
                        makeRoomCode()
                        .toLowerCase();

                    const room=
                        makeRoom(
                            roomId,
                            count,
                            false
                        );

                    rooms.set(
                        roomId,
                        room
                    );

                    startRoom(
                        roomId,
                        matched
                    );

                }

            }
        );


        /* =================================================
           CREATE PRIVATE
        ================================================= */

        socket.on(
            'createPrivateGame',
            numberOfPlayers=>{

                const count=
                    Number(
                        numberOfPlayers
                    );

                if(
                    ![2,3,4].includes(count)
                ){

                    socket.emit(
                        'roomError',
                        'Invalid player count.'
                    );

                    return;

                }

                removeFromQueues(
                    socket.id
                );

                const roomId=
                    makeRoomCode();

                const room=
                    makeRoom(
                        roomId,
                        count,
                        true
                    );

                rooms.set(
                    roomId,
                    room
                );

                room.sockets.push(
                    socket
                );

                socket.data.roomId=
                    roomId;

                socket.data.playerId=
                    null;

                socket.join(roomId);

                socket.emit(
                    'privateRoomCreated',
                    roomId
                );

                sendMessage(
                    room,
                    `Room created. Share code ${roomId}. Waiting for players (1/${count})...`
                );

            }
        );


        /* =================================================
           JOIN PRIVATE
        ================================================= */

        socket.on(
            'joinPrivateGame',
            rawCode=>{

                const roomId=
                    String(
                        rawCode||''
                    )
                    .trim()
                    .toUpperCase();

                const room=
                    rooms.get(roomId);

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

                removeFromQueues(
                    socket.id
                );

                room.sockets.push(
                    socket
                );

                socket.data.roomId=
                    roomId;

                socket.data.playerId=
                    null;

                socket.join(roomId);

                sendMessage(
                    room,
                    `Player joined (${room.sockets.length}/${room.maxPlayers})...`
                );

                if(
                    room.sockets.length===
                    room.maxPlayers
                ){

                    startRoom(
                        roomId,
                        room.sockets
                    );

                }

            }
        );


        /* =================================================
           ROLL DICE
        ================================================= */

        socket.on(
            'requestRoll',
            ()=>{

                const room=
                    getRoom(socket);

                if(
                    !room ||
                    !room.started ||
                    room.finished
                )
                    return;

                const player=
                    getCurrentPlayer(room);

                if(!player)
                    return;

                if(
                    Number(
                        socket.data.playerId
                    )!==player.id
                ){

                    socket.emit(
                        'actionError',
                        'It is not your turn.'
                    );

                    return;

                }


                /*
                   The player can roll when:
                   - starting the turn
                   - a 4/8 granted another roll
                   - capture/HOME granted another roll
                */

                if(!room.canRoll){

                    socket.emit(
                        'actionError',
                        'You cannot roll right now.'
                    );

                    return;

                }


                /*
                   If a previous 4/8 was the reason
                   for this roll, consume its bonus.
                */

                if(
                    room.rollPermissionIndex>=0 &&
                    room.rollPermissionIndex<
                    room.pendingRolls.length
                ){

                    room.pendingRolls[
                        room.rollPermissionIndex
                    ].extraUsed=true;

                }

                room.rollPermissionIndex=-1;


                const roll=
                    DICE_VALUES[
                        Math.floor(
                            Math.random()*
                            DICE_VALUES.length
                        )
                    ];


                const rollObject={
                    value:roll,
                    extraUsed:false
                };


                room.pendingRolls.push(
                    rollObject
                );


                player.lastRoll=
                    roll;


                /*
                   4 / 8 allows another roll.
                */

                if(
                    roll===4 ||
                    roll===8
                ){

                    room.canRoll=true;

                    room.rollPermissionIndex=
                        room.pendingRolls.length-1;

                }else{

                    room.canRoll=false;

                    room.rollPermissionIndex=-1;

                }


                io.to(room.id).emit(
                    'diceRolled',
                    {
                        playerId:
                            player.id,

                        value:
                            roll
                    }
                );


                /*
                   Check only the newly rolled
                   dice for a possible move.
                */

                if(
                    !hasValidMove(
                        player,
                        roll
                    )
                ){

                    const index=
                        room.pendingRolls.length-1;

                    room.pendingRolls.splice(
                        index,
                        1
                    );

                    if(
                        room.rollPermissionIndex===
                        index
                    ){

                        room.rollPermissionIndex=-1;

                    }


                    if(
                        roll===4 ||
                        roll===8
                    ){

                        room.canRoll=true;

                        sendMessage(
                            room,
                            `${player.name} rolled ${roll}. No valid move — extra roll!`
                        );

                        sendState(room);

                        return;

                    }


                    /*
                       If other dice are already
                       stored, continue with them.
                    */

                    if(
                        room.pendingRolls.length
                    ){

                        room.canRoll=false;

                        sendMessage(
                            room,
                            `${player.name} rolled ${roll}. No valid move. Use another stored dice.`
                        );

                        sendState(room);

                        return;

                    }


                    room.canRoll=false;

                    room.active=
                        nextActive(room);

                    room.canRoll=true;

                    room.rollPermissionIndex=-1;

                    const next=
                        getCurrentPlayer(room);

                    if(next){

                        sendMessage(
                            room,
                            `${next.name}'s turn.`
                        );

                    }

                    sendState(room);

                    return;

                }


                sendMessage(
                    room,
                    `${player.name} rolled ${roll}.`
                );

                sendState(room);

            }
        );


        /* =================================================
           MOVE
        ================================================= */

        socket.on(
            'requestMove',
            data=>{

                const room=
                    getRoom(socket);

                if(
                    !room ||
                    !room.started ||
                    room.finished
                )
                    return;

                const playerId=
                    Number(
                        data?.playerId
                    );

                const pawnIndex=
                    Number(
                        data?.pawnIndex
                    );

                let rollIndex=
                    Number(
                        data?.rollIndex
                    );


                const player=
                    getCurrentPlayer(room);


                if(
                    !player ||
                    Number(
                        socket.data.playerId
                    )!==playerId ||
                    player.id!==playerId
                ){

                    socket.emit(
                        'actionError',
                        'You cannot control this player.'
                    );

                    return;

                }


                if(
                    !Number.isInteger(
                        rollIndex
                    ) ||
                    rollIndex<0 ||
                    rollIndex>=
                    room.pendingRolls.length
                ){

                    socket.emit(
                        'actionError',
                        'Choose a dice number first.'
                    );

                    return;

                }


                const rollObject=
                    room.pendingRolls[
                        rollIndex
                    ];

                if(!rollObject){

                    socket.emit(
                        'actionError',
                        'Dice not found.'
                    );

                    return;

                }


                const roll=
                    Number(
                        rollObject.value
                    );


                if(
                    !isValidMove(
                        player,
                        pawnIndex,
                        roll
                    )
                ){

                    socket.emit(
                        'actionError',
                        'That pawn cannot move that far.'
                    );

                    return;

                }


                const from=
                    player.pawns[pawnIndex];

                const to=
                    from+roll;


                /*
                   Did this particular 4/8
                   already grant its extra roll?
                */

                const diceHadExtra=
                    (
                        (roll===4 || roll===8) &&
                        !rollObject.extraUsed
                    );


                /*
                   Remove selected dice.
                */

                room.pendingRolls.splice(
                    rollIndex,
                    1
                );


                if(
                    room.rollPermissionIndex===
                    rollIndex
                ){

                    room.rollPermissionIndex=-1;

                }else if(
                    room.rollPermissionIndex>
                    rollIndex
                ){

                    room.rollPermissionIndex--;

                }


                player.pawns[pawnIndex]=to;

                room.canRoll=false;


                /* =================================================
                   CAPTURE
                ================================================= */

                let captureHappened=false;

                const captured=[];

                const boardCell=
                    PATHS[
                        player.id
                    ][to];


                if(
                    to<24 &&
                    !SAFE.includes(boardCell)
                ){

                    room.players.forEach(
                        opponent=>{

                            if(
                                opponent.id===
                                player.id ||
                                opponent.hasWon
                            )
                                return;


                            for(
                                let j=0;
                                j<4;
                                j++
                            ){

                                const step=
                                    opponent.pawns[j];

                                if(step>=24)
                                    continue;


                                const opponentCell=
                                    PATHS[
                                        opponent.id
                                    ][step];


                                if(
                                    opponentCell===
                                    boardCell
                                ){

                                    opponent.pawns[j]=0;

                                    captured.push({
                                        playerId:
                                            opponent.id,
                                        pawnIndex:j
                                    });

                                    captureHappened=true;

                                }

                            }

                        }
                    );

                }


                if(captureHappened){

                    player.hasKilled=true;

                }


                /* =================================================
                   HOME
                ================================================= */

                const reachedHome=
                    to===24;


                if(
                    player.pawns.every(
                        step=>step===24
                    )
                ){

                    player.hasWon=true;

                    player.rank=
                        room.rank++;

                    sendMessage(
                        room,
                        `🏆 ${player.name} finished in position ${player.rank}!`
                    );

                }


                /* =================================================
                   EXTRA TURN
                ================================================= */

                let extraTurn=
                    diceHadExtra ||
                    captureHappened ||
                    (
                        reachedHome &&
                        !player.hasWon
                    );


                if(player.hasWon)
                    extraTurn=false;


                if(
                    player.hasWon
                ){

                    checkGameFinished(
                        room
                    );

                    extraTurn=false;

                }


                /* =================================================
                   WHAT HAPPENS NEXT?
                ================================================= */

                if(!room.finished){

                    /*
                       If stored dice remain,
                       player continues their turn.
                    */

                    if(
                        room.pendingRolls.length
                    ){

                        if(extraTurn){

                            room.canRoll=true;

                            room.rollPermissionIndex=-1;

                            if(captureHappened){

                                sendMessage(
                                    room,
                                    `${player.name} captured a pawn — roll again!`
                                );

                            }else if(
                                reachedHome &&
                                !player.hasWon
                            ){

                                sendMessage(
                                    room,
                                    `${player.name} reached HOME — roll again!`
                                );

                            }else{

                                sendMessage(
                                    room,
                                    `${player.name} gets another roll!`
                                );

                            }

                        }else{

                            /*
                               If a remaining dice has
                               an unused 4/8 permission,
                               allow another roll.
                            */

                            const permission=
                                room.pendingRolls.findIndex(
                                    r=>
                                        (
                                            (
                                                r.value===4 ||
                                                r.value===8
                                            ) &&
                                            !r.extraUsed
                                        )
                                );

                            if(
                                permission>=0
                            ){

                                room.canRoll=true;

                                room.rollPermissionIndex=
                                    permission;

                            }else{

                                room.canRoll=false;

                                room.rollPermissionIndex=-1;

                            }

                        }

                    }else if(extraTurn){

                        room.canRoll=true;

                        room.rollPermissionIndex=-1;

                    }else{

                        room.active=
                            nextActive(room);

                        room.canRoll=true;

                        room.rollPermissionIndex=-1;

                        const nextPlayer=
                            getCurrentPlayer(room);

                        if(nextPlayer){

                            sendMessage(
                                room,
                                `${nextPlayer.name}'s turn.`
                            );

                        }

                    }

                }


                /* =================================================
                   MOVE RESULT
                ================================================= */

                io.to(room.id).emit(
                    'moveResult',
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

                        captured:
                            captured,

                        extraTurn:
                            extraTurn,

                        finished:
                            room.finished

                    }
                );


                sendState(room);


                if(room.finished){

                    io.to(room.id).emit(
                        'gameFinished'
                    );

                }

            }
        );


        /* =================================================
           CHAT
        ================================================= */

        socket.on(
            'sendChatMessage',
            data=>{

                const room=
                    getRoom(socket);

                if(!room)
                    return;

                const player=
                    room.players.find(
                        p=>
                            p.id===
                            socket.data.playerId
                    );

                if(!player)
                    return;

                const text=
                    String(
                        data?.text||''
                    )
                    .trim()
                    .slice(0,300);

                if(!text)
                    return;

                io.to(room.id).emit(
                    'receiveChatMessage',
                    {

                        name:
                            player.name,

                        text:
                            text

                    }
                );

            }
        );


        /* =================================================
           VOICE
        ================================================= */

        socket.on(
            'voiceJoin',
            ()=>{

                const room=
                    getRoom(socket);

                if(!room)
                    return;

                const peers=
                    room.sockets
                    .filter(
                        s=>s!==socket
                    )
                    .map(
                        s=>s.id
                    );

                socket.emit(
                    'voicePeers',
                    peers
                );

            }
        );


        socket.on(
            'voiceSignal',
            data=>{

                const room=
                    getRoom(socket);

                if(
                    !room ||
                    !data ||
                    !data.to
                )
                    return;

                const target=
                    room.sockets.find(
                        s=>
                            s.id===
                            data.to
                    );

                if(target){

                    target.emit(
                        'voiceSignal',
                        {

                            from:
                                socket.id,

                            data:
                                data.data

                        }
                    );

                }

            }
        );


        /* =================================================
           DISCONNECT
        ================================================= */

        socket.on(
            'disconnect',
            ()=>{

                console.log(
                    'Disconnected:',
                    socket.id
                );

                removeFromQueues(
                    socket.id
                );

                const room=
                    getRoom(socket);

                if(!room)
                    return;

                closeRoom(
                    room.id,
                    'A player disconnected. The match has ended.'
                );

            }
        );

    }
);


/* =========================================================
   SERVER
========================================================= */

const PORT=
    process.env.PORT || 3000;

server.listen(
    PORT,
    ()=>{
        console.log(
            `Ludo Twist server running on port ${PORT}`
        );
    }
);
