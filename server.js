const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

/* =========================================================
   LUDO TWIST — SERVER
   =========================================================
   RULES
   ---------------------------------------------------------
   Dice: 1,2,3,4,8
   4 or 8 = extra roll
   Capture = extra roll
   Reaching HOME = extra roll
   All 4 pawns HOME = player finishes
   Before first capture: maximum step 15
   After capture: maximum step 24
   Safe cells: 2,10,12,14,22
   ========================================================= */


/* -------------------- PLAYERS -------------------- */

const COLORS = [
    '#1e90ff',
    '#ff4757',
    '#2ed573',
    '#ffa502'
];

const NAMES = [
    'Blue',
    'Red',
    'Green',
    'Yellow'
];


/* -------------------- BOARD PATHS -------------------- */

const PATHS = [

    // BLUE
    [
        10,15,20,21,22,23,24,
        19,14,9,4,3,2,1,0,
        5,6,7,8,13,18,17,16,11,12
    ],

    // RED
    [
        2,1,0,5,10,15,20,21,22,23,24,
        19,14,9,4,3,8,13,18,17,16,11,6,7,12
    ],

    // GREEN
    [
        14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,
        19,18,17,16,11,6,7,8,13,12
    ],

    // YELLOW
    [
        22,23,24,19,14,9,4,3,2,1,0,
        5,10,15,20,21,16,11,6,7,8,13,18,17,12
    ]

];


/* -------------------- RULE DATA -------------------- */

const SAFE = [2, 10, 12, 14, 22];

/*
   Weighted dice:
   1 = 2 chances
   2 = 2 chances
   3 = 2 chances
   4 = 1 chance
   8 = 1 chance
*/
const DICE_VALUES = [
    1, 1,
    2, 2,
    3, 3,
    4,
    8
];


/* -------------------- MATCHMAKING -------------------- */

const queues = {
    2: [],
    3: [],
    4: []
};

const rooms = new Map();


/* =========================================================
   PLAYER / ROOM CREATION
   ========================================================= */

function makePlayer(id) {

    return {
        id: id,
        name: NAMES[id],
        color: COLORS[id],

        pawns: [0, 0, 0, 0],

        // Becomes true after this player captures
        hasKilled: false,

        hasWon: false,
        rank: 0
    };
}


function makeRoom(id, maxPlayers, isPrivate) {

    return {

        id: id,

        maxPlayers: maxPlayers,

        isPrivate: isPrivate,

        sockets: [],

        players: [],

        started: false,

        finished: false,

        // Index inside players[]
        active: 0,

        // Current dice waiting to be used
        pendingRoll: null,

        // Whether active player can roll
        canRoll: true,

        // Ranking counter
        rank: 1
    };
}


/* =========================================================
   HELPERS
   ========================================================= */

function getRoom(socket) {

    if (!socket.data.roomId) {
        return null;
    }

    return rooms.get(socket.data.roomId) || null;
}


function getCurrentPlayer(room) {

    if (!room || !room.players.length) {
        return null;
    }

    return room.players[room.active];
}


function removeFromQueues(socketId) {

    for (const count of [2, 3, 4]) {

        queues[count] = queues[count].filter(
            socket => socket && socket.id !== socketId
        );

    }
}


function makeRoomCode() {

    let code;

    do {

        code = Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase();

    } while (rooms.has(code));

    return code;
}


/* =========================================================
   TURN HANDLING
   ========================================================= */

function nextActive(room) {

    if (!room || !room.players.length) {
        return 0;
    }

    for (let step = 1; step <= room.players.length; step++) {

        const next =
            (room.active + step) % room.players.length;

        const player = room.players[next];

        if (player && !player.hasWon) {
            return next;
        }
    }

    return room.active;
}


/* =========================================================
   MOVEMENT VALIDATION
   ========================================================= */

function isValidMove(player, pawnIndex, roll) {

    if (!player) {
        return false;
    }

    if (player.hasWon) {
        return false;
    }

    if (!Number.isInteger(pawnIndex)) {
        return false;
    }

    if (pawnIndex < 0 || pawnIndex > 3) {
        return false;
    }

    const currentStep = player.pawns[pawnIndex];

    // Already at HOME
    if (currentStep >= 24) {
        return false;
    }

    const destination = currentStep + roll;

    /*
       Original Ludo Twist rule:
       Before player has captured:
       maximum step = 15

       After player has captured:
       maximum step = 24
    */
    const maximum =
        player.hasKilled ? 24 : 15;

    if (destination > maximum) {
        return false;
    }

    return true;
}


function hasValidMove(player, roll) {

    for (let i = 0; i < 4; i++) {

        if (isValidMove(player, i, roll)) {
            return true;
        }

    }

    return false;
}


/* =========================================================
   GAME STATE
   ========================================================= */

function getPublicState(room) {

    return {

        active: room.active,

        pendingRoll: room.pendingRoll,

        canRoll: room.canRoll,

        rank: room.rank,

        finished: room.finished,

        players: room.players.map(player => {

            return {

                id: player.id,

                name: player.name,

                color: player.color,

                pawns: [...player.pawns],

                hasKilled: player.hasKilled,

                hasWon: player.hasWon,

                rank: player.rank
            };

        })

    };
}


function sendState(room) {

    if (!room) {
        return;
    }

    io.to(room.id).emit(
        'gameState',
        getPublicState(room)
    );
}


function sendMessage(room, message) {

    if (!room) {
        return;
    }

    io.to(room.id).emit(
        'systemMessage',
        message
    );
}


/* =========================================================
   PLAYER FINISH / GAME FINISH
   ========================================================= */

function checkGameFinished(room) {

    const remaining =
        room.players.filter(player => !player.hasWon);

    /*
       If only one player remains unfinished,
       the game is complete.
    */
    if (remaining.length <= 1) {

        if (remaining.length === 1) {

            const lastPlayer = remaining[0];

            lastPlayer.hasWon = true;
            lastPlayer.rank = room.rank++;

        }

        room.finished = true;
        room.canRoll = false;
        room.pendingRoll = null;

        sendMessage(
            room,
            '🏆 Game finished!'
        );

        return true;
    }

    return false;
}


/* =========================================================
   START ROOM
   ========================================================= */

function startRoom(roomId, sockets) {

    const room = rooms.get(roomId);

    if (!room) {
        return;
    }

    room.sockets = sockets;
    room.players = [];

    room.started = true;
    room.finished = false;

    room.active = 0;

    room.pendingRoll = null;

    room.canRoll = true;

    room.rank = 1;


    sockets.forEach((socket, index) => {

        const playerId = index;

        socket.data.roomId = roomId;
        socket.data.playerId = playerId;

        socket.join(roomId);

        const player =
            makePlayer(playerId);

        room.players.push(player);

        socket.emit(
            'assignPlayer',
            {
                playerId: playerId,
                playerName: NAMES[playerId]
            }
        );

    });


    io.to(roomId).emit(
        'gameStart',
        {
            players: room.players.map(
                player => player.id
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

function closeRoom(roomId, message) {

    const room = rooms.get(roomId);

    if (!room) {
        return;
    }

    io.to(roomId).emit(
        'roomClosed',
        message || 'Room closed.'
    );


    for (const socket of room.sockets) {

        socket.leave(roomId);

        socket.data.roomId = null;
        socket.data.playerId = null;

    }


    rooms.delete(roomId);
}


/* =========================================================
   CONNECTION
   ========================================================= */

io.on('connection', socket => {

    console.log(
        'Connected:',
        socket.id
    );


    /* =====================================================
       PUBLIC MATCHMAKING
       ===================================================== */

    socket.on('joinGame', numberOfPlayers => {

        const count =
            Number(numberOfPlayers);


        if (![2, 3, 4].includes(count)) {

            socket.emit(
                'roomError',
                'Invalid player count.'
            );

            return;
        }


        removeFromQueues(socket.id);

        queues[count].push(socket);


        socket.emit(
            'systemMessage',
            `Waiting for ${
                count - queues[count].length
            } more player(s)...`
        );


        if (queues[count].length >= count) {

            const matched =
                queues[count].splice(0, count);


            const roomId =
                'pub_' +
                makeRoomCode().toLowerCase();


            const newRoom =
                makeRoom(
                    roomId,
                    count,
                    false
                );


            rooms.set(
                roomId,
                newRoom
            );


            startRoom(
                roomId,
                matched
            );

        }

    });


    /* =====================================================
       CREATE PRIVATE ROOM
       ===================================================== */

    socket.on(
        'createPrivateGame',
        numberOfPlayers => {

            const count =
                Number(numberOfPlayers);


            if (![2, 3, 4].includes(count)) {

                socket.emit(
                    'roomError',
                    'Invalid player count.'
                );

                return;
            }


            removeFromQueues(socket.id);


            const roomId =
                makeRoomCode();


            const newRoom =
                makeRoom(
                    roomId,
                    count,
                    true
                );


            rooms.set(
                roomId,
                newRoom
            );


            newRoom.sockets.push(socket);

            socket.data.roomId = roomId;
            socket.data.playerId = null;

            socket.join(roomId);


            socket.emit(
                'privateRoomCreated',
                roomId
            );


            sendMessage(
                newRoom,
                `Room created. Share code ${roomId}. Waiting for players (1/${count})...`
            );

        }
    );


    /* =====================================================
       JOIN PRIVATE ROOM
       ===================================================== */

    socket.on(
        'joinPrivateGame',
        rawCode => {

            const roomId =
                String(rawCode || '')
                    .trim()
                    .toUpperCase();


            const room =
                rooms.get(roomId);


            if (!room) {

                socket.emit(
                    'roomError',
                    'Room code not found!'
                );

                return;
            }


            if (room.started) {

                socket.emit(
                    'roomError',
                    'Game has already started!'
                );

                return;
            }


            if (
                room.sockets.length >=
                room.maxPlayers
            ) {

                socket.emit(
                    'roomError',
                    'Room is full!'
                );

                return;
            }


            removeFromQueues(socket.id);


            room.sockets.push(socket);

            socket.data.roomId = roomId;
            socket.data.playerId = null;

            socket.join(roomId);


            sendMessage(
                room,
                `Player joined (${room.sockets.length}/${room.maxPlayers})...`
            );


            if (
                room.sockets.length ===
                room.maxPlayers
            ) {

                startRoom(
                    roomId,
                    room.sockets
                );

            }

        }
    );


    /* =====================================================
       REQUEST DICE ROLL
       ===================================================== */

    socket.on(
        'requestRoll',
        () => {

            const room =
                getRoom(socket);


            if (!room || !room.started) {
                return;
            }


            if (room.finished) {
                return;
            }


            const player =
                getCurrentPlayer(room);


            if (!player) {
                return;
            }


            /*
               Only active player can roll.
            */
            if (
                socket.data.playerId !==
                player.id
            ) {

                socket.emit(
                    'actionError',
                    'It is not your turn.'
                );

                return;
            }


            /*
               Cannot roll while a previous
               dice result is waiting for a move.
            */
            if (
                !room.canRoll ||
                room.pendingRoll !== null
            ) {

                socket.emit(
                    'actionError',
                    'You cannot roll right now.'
                );

                return;
            }


            /*
               Weighted dice.
            */
            const roll =
                DICE_VALUES[
                    Math.floor(
                        Math.random() *
                        DICE_VALUES.length
                    )
                ];


            room.pendingRoll = roll;
            room.canRoll = false;


            /*
               Tell every client the actual
               number that was rolled.
            */
            io.to(room.id).emit(
                'diceRolled',
                {
                    playerId: player.id,
                    value: roll
                }
            );


            /*
               Check whether at least one pawn
               can actually move.
            */
            if (
                !hasValidMove(
                    player,
                    roll
                )
            ) {

                room.pendingRoll = null;


                /*
                   4 or 8 still gives an
                   extra roll even if no pawn
                   can move.
                */
                if (
                    roll === 4 ||
                    roll === 8
                ) {

                    room.canRoll = true;

                    sendMessage(
                        room,
                        `${player.name} rolled ${roll}. No valid move — extra roll!`
                    );

                    sendState(room);

                } else {

                    sendMessage(
                        room,
                        `${player.name} rolled ${roll}. No valid move.`
                    );


                    room.active =
                        nextActive(room);

                    room.canRoll = true;

                    sendState(room);

                }


                return;
            }


            sendMessage(
                room,
                `${player.name} rolled ${roll}. Tap a pawn.`
            );


            sendState(room);

        }
    );


    /* =====================================================
       REQUEST PAWN MOVE
       ===================================================== */

    socket.on(
        'requestMove',
        data => {

            const room =
                getRoom(socket);


            if (!room || !room.started) {
                return;
            }


            if (room.finished) {
                return;
            }


            const playerId =
                Number(data?.playerId);


            const pawnIndex =
                Number(data?.pawnIndex);


            const player =
                getCurrentPlayer(room);


            /*
               Validate player ownership.
            */
            if (
                !player ||
                socket.data.playerId !==
                playerId ||
                player.id !== playerId
            ) {

                socket.emit(
                    'actionError',
                    'You cannot control this player.'
                );

                return;
            }


            /*
               There must be an active dice roll.
            */
            if (
                room.pendingRoll === null
            ) {

                socket.emit(
                    'actionError',
                    'Roll the dice first.'
                );

                return;
            }


            const roll =
                room.pendingRoll;


            /*
               Validate pawn.
            */
            if (
                !isValidMove(
                    player,
                    pawnIndex,
                    roll
                )
            ) {

                socket.emit(
                    'actionError',
                    'That pawn cannot move that far.'
                );

                return;
            }


            const from =
                player.pawns[pawnIndex];


            const to =
                from + roll;


            /*
               Move pawn.
            */
            player.pawns[pawnIndex] =
                to;


            room.pendingRoll = null;


            /* =================================================
               CAPTURE
               ================================================= */

            let captured = [];
            let captureHappened = false;


            const boardCell =
                PATHS[player.id][to];


            /*
               HOME is never a capture.
               Safe cells cannot be captured.
            */
            if (
                to < 24 &&
                !SAFE.includes(boardCell)
            ) {

                for (
                    const opponent
                    of room.players
                ) {

                    if (
                        opponent.id ===
                        player.id
                    ) {
                        continue;
                    }


                    if (
                        opponent.hasWon
                    ) {
                        continue;
                    }


                    for (
                        let j = 0;
                        j < 4;
                        j++
                    ) {

                        const opponentStep =
                            opponent.pawns[j];


                        if (
                            opponentStep >= 24
                        ) {
                            continue;
                        }


                        const opponentCell =
                            PATHS[
                                opponent.id
                            ][opponentStep];


                        if (
                            opponentCell ===
                            boardCell
                        ) {

                            /*
                               Send captured pawn
                               back to start.
                            */
                            opponent.pawns[j] =
                                0;


                            captured.push({
                                playerId:
                                    opponent.id,

                                pawnIndex:
                                    j
                            });


                            captureHappened =
                                true;

                        }

                    }

                }

            }


            /*
               Once a player has captured,
               they can use the full path
               up to HOME.
            */
            if (captureHappened) {

                player.hasKilled = true;

            }


            /* =================================================
               HOME
               ================================================= */

            const reachedHome =
                to === 24;


            if (
                player.pawns.every(
                    step => step === 24
                )
            ) {

                player.hasWon = true;

                player.rank =
                    room.rank++;

                sendMessage(
                    room,
                    `🏆 ${player.name} finished in position ${player.rank}!`
                );

            }


            /* =================================================
               EXTRA TURN
               ================================================= */

            let extraTurn = false;


            /*
               4 or 8 always gives another roll
               after the move.
            */
            if (
                roll === 4 ||
                roll === 8
            ) {

                extraTurn = true;

            }


            /*
               Capture gives another roll.
            */
            if (captureHappened) {

                extraTurn = true;

            }


            /*
               Reaching HOME gives another roll,
               unless the player has completed
               all four pawns and therefore finished.
            */
            if (
                reachedHome &&
                !player.hasWon
            ) {

                extraTurn = true;

            }


            /*
               A player who has finished cannot
               continue taking turns.
            */
            if (player.hasWon) {

                extraTurn = false;

            }


            /* =================================================
               CHECK GAME END
               ================================================= */

            if (
                player.hasWon &&
                checkGameFinished(room)
            ) {

                extraTurn = false;

            }


            /* =================================================
               DECIDE NEXT TURN
               ================================================= */

            if (!room.finished) {

                if (extraTurn) {

                    /*
                       SAME PLAYER
                       gets another roll.
                    */
                    room.canRoll = true;

                    if (captureHappened) {

                        sendMessage(
                            room,
                            `${player.name} captured a pawn — extra roll!`
                        );

                    } else if (
                        reachedHome &&
                        !player.hasWon
                    ) {

                        sendMessage(
                            room,
                            `${player.name} reached HOME — extra roll!`
                        );

                    } else {

                        sendMessage(
                            room,
                            `${player.name} rolled ${roll} — extra roll!`
                        );

                    }

                } else {

                    /*
                       Normal turn:
                       move to next player.
                    */
                    room.active =
                        nextActive(room);

                    room.canRoll = true;

                    const nextPlayer =
                        getCurrentPlayer(room);


                    if (nextPlayer) {

                        sendMessage(
                            room,
                            `${nextPlayer.name}'s turn.`
                        );

                    }

                }

            }


            /* =================================================
               BROADCAST MOVE
               ================================================= */

            io.to(room.id).emit(
                'moveResult',
                {
                    playerId: playerId,

                    pawnIndex: pawnIndex,

                    from: from,

                    to: to,

                    roll: roll,

                    captured: captured,

                    extraTurn: extraTurn,

                    finished: room.finished
                }
            );


            sendState(room);


            if (room.finished) {

                io.to(room.id).emit(
                    'gameFinished'
                );

            }

        }
    );


    /* =====================================================
       CHAT
       ===================================================== */

    socket.on(
        'sendChatMessage',
        data => {

            const room =
                getRoom(socket);


            if (!room) {
                return;
            }


            const player =
                room.players.find(
                    p =>
                        p.id ===
                        socket.data.playerId
                );


            if (!player) {
                return;
            }


            const text =
                String(
                    data?.text || ''
                )
                .trim()
                .slice(0, 300);


            if (!text) {
                return;
            }


            io.to(room.id).emit(
                'receiveChatMessage',
                {
                    name: player.name,
                    text: text
                }
            );

        }
    );


    /* =====================================================
       VOICE CHAT
       ===================================================== */

    socket.on(
        'voiceJoin',
        () => {

            const room =
                getRoom(socket);


            if (!room) {
                return;
            }


            const peers =
                room.sockets
                    .filter(
                        s =>
                            s !== socket
                    )
                    .map(
                        s => s.id
                    );


            socket.emit(
                'voicePeers',
                peers
            );

        }
    );


    socket.on(
        'voiceSignal',
        data => {

            const room =
                getRoom(socket);


            if (
                !room ||
                !data ||
                !data.to
            ) {
                return;
            }


            const target =
                room.sockets.find(
                    s =>
                        s.id ===
                        data.to
                );


            if (target) {

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


    /* =====================================================
       DISCONNECT
       ===================================================== */

    socket.on(
        'disconnect',
        () => {

            console.log(
                'Disconnected:',
                socket.id
            );


            removeFromQueues(
                socket.id
            );


            const room =
                getRoom(socket);


            if (!room) {
                return;
            }


            /*
               If somebody leaves an active
               multiplayer match, close it.
            */
            closeRoom(
                room.id,
                'A player disconnected. The match has ended.'
            );

        }
    );

});


/* =========================================================
   SERVER START
   ========================================================= */

const PORT =
    process.env.PORT || 3000;


server.listen(
    PORT,
    () => {

        console.log(
            `Ludo Twist server running on port ${PORT}`
        );

    }
);
