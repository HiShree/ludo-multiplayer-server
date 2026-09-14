const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

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
   LUDO TWIST SERVER
========================================================= */

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


/* =========================================================
   PLAYER PATHS
========================================================= */

const PATHS = [

    [
        10,15,20,21,22,23,24,
        19,14,9,4,3,2,1,0,
        5,6,7,8,13,18,17,16,11,12
    ],

    [
        2,1,0,5,10,15,20,21,22,23,24,
        19,14,9,4,3,8,13,18,17,16,
        11,6,7,12
    ],

    [
        14,9,4,3,2,1,0,5,10,15,20,
        21,22,23,24,19,18,17,16,11,
        6,7,8,13,12
    ],

    [
        22,23,24,19,14,9,4,3,2,1,0,
        5,10,15,20,21,16,11,6,7,8,
        13,18,17,12
    ]

];


/* =========================================================
   SAFE CELLS
========================================================= */

const SAFE = [
    2,
    10,
    12,
    14,
    22
];


/* =========================================================
   DICE
   4 AND 8 ARE RARE
========================================================= */

function rollDiceValue() {

    const r = Math.random();

    if (r < 0.38) return 1;

    if (r < 0.76) return 2;

    if (r < 0.96) return 3;

    if (r < 0.985) return 4;

    return 8;
}


/* =========================================================
   QUEUES / ROOMS
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

function makePlayer(id) {

    return {

        id: id,

        name: NAMES[id],

        color: COLORS[id],

        pawns: [
            0,
            0,
            0,
            0
        ],

        hasKilled: false,

        hasWon: false,

        rank: 0
    };
}


/* =========================================================
   ROOM
========================================================= */

function makeRoom(
    id,
    maxPlayers,
    isPrivate
) {

    return {

        id: id,

        maxPlayers: maxPlayers,

        isPrivate: isPrivate,

        sockets: [],

        players: [],

        started: false,

        finished: false,

        active: 0,

        pendingRolls: [],

        canRoll: true,

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

    return rooms.get(
        socket.data.roomId
    ) || null;
}


function getCurrentPlayer(room) {

    if (
        !room ||
        !room.players ||
        !room.players.length
    ) {
        return null;
    }

    return room.players[
        room.active
    ];
}


function removeFromQueues(socketId) {

    for (
        const count of [2, 3, 4]
    ) {

        queues[count] =
            queues[count].filter(
                socket =>
                    socket &&
                    socket.id !== socketId
            );
    }
}


function makeRoomCode() {

    let code;

    do {

        code =
            Math.random()
                .toString(36)
                .slice(2, 8)
                .toUpperCase();

    } while (
        rooms.has(code)
    );

    return code;
}


/* =========================================================
   NEXT PLAYER
========================================================= */

function nextActive(room) {

    if (
        !room ||
        !room.players.length
    ) {
        return 0;
    }

    for (
        let step = 1;
        step <= room.players.length;
        step++
    ) {

        const index =
            (
                room.active +
                step
            ) % room.players.length;

        const player =
            room.players[index];

        if (
            player &&
            !player.hasWon
        ) {
            return index;
        }
    }

    return room.active;
}


/* =========================================================
   MOVE VALIDATION
========================================================= */

function isValidMove(
    player,
    pawnIndex,
    roll
) {

    if (!player) return false;

    if (player.hasWon) return false;

    if (
        !Number.isInteger(
            pawnIndex
        )
    ) {
        return false;
    }

    if (
        pawnIndex < 0 ||
        pawnIndex > 3
    ) {
        return false;
    }

    const step =
        player.pawns[pawnIndex];

    if (step >= 24) {
        return false;
    }

    const maximum =
        player.hasKilled
            ? 24
            : 15;

    return (
        step + roll <= maximum
    );
}


function hasValidMove(
    player,
    roll
) {

    return [0, 1, 2, 3].some(
        index =>
            isValidMove(
                player,
                index,
                roll
            )
    );
}


/* =========================================================
   PUBLIC STATE
========================================================= */

function publicState(room) {

    return {

        active:
            room.active,

        pendingRolls:
            room.pendingRolls.map(
                r => ({
                    value: r.value,
                    extraAvailable:
                        r.extraAvailable
                })
            ),

        canRoll:
            room.canRoll,

        rank:
            room.rank,

        finished:
            room.finished,

        players:
            room.players.map(
                player => ({

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
                        player.rank
                })
            )
    };
}


function sendState(room) {

    if (!room) return;

    io.to(room.id).emit(
        'gameState',
        publicState(room)
    );
}


function sendMessage(
    room,
    message
) {

    if (!room) return;

    io.to(room.id).emit(
        'systemMessage',
        message
    );
}


/* =========================================================
   GAME FINISHED
========================================================= */

function checkGameFinished(room) {

    const remaining =
        room.players.filter(
            player =>
                !player.hasWon
        );

    if (
        remaining.length <= 1
    ) {

        if (
            remaining.length === 1
        ) {

            remaining[0].hasWon = true;

            remaining[0].rank =
                room.rank++;
        }

        room.finished = true;

        room.canRoll = false;

        room.pendingRolls = [];

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

function startRoom(
    roomId,
    sockets
) {

    const room =
        rooms.get(roomId);

    if (!room) return;

    room.sockets = [
        ...sockets
    ];

    room.players = [];

    room.started = true;

    room.finished = false;

    room.active = 0;

    room.pendingRolls = [];

    room.canRoll = true;

    room.rank = 1;


    sockets.forEach(
        (socket, index) => {

            socket.data.roomId =
                roomId;

            socket.data.playerId =
                index;

            socket.join(roomId);

            room.players.push(
                makePlayer(index)
            );

            socket.emit(
                'assignPlayer',
                {
                    playerId:
                        index,

                    playerName:
                        NAMES[index]
                }
            );
        }
    );


    io.to(roomId).emit(
        'gameStart',
        {
            players:
                room.players.map(
                    player =>
                        player.id
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
) {

    const room =
        rooms.get(roomId);

    if (!room) return;

    io.to(roomId).emit(
        'roomClosed',
        message ||
        'Room closed.'
    );

    room.sockets.forEach(
        socket => {

            socket.leave(roomId);

            socket.data.roomId =
                null;

            socket.data.playerId =
                null;
        }
    );

    rooms.delete(roomId);
}


/* =========================================================
   CONNECTION
========================================================= */

io.on(
    'connection',
    socket => {

        console.log(
            'Connected:',
            socket.id
        );


        /* =================================================
           PUBLIC GAME
        ================================================= */

        socket.on(
            'joinGame',
            numberOfPlayers => {

                const count =
                    Number(
                        numberOfPlayers
                    );

                if (
                    ![2, 3, 4]
                        .includes(count)
                ) {

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
                        count -
                        queues[count].length
                    } more player(s)...`
                );


                if (
                    queues[count].length >=
                    count
                ) {

                    const matched =
                        queues[count]
                            .splice(
                                0,
                                count
                            );

                    const roomId =
                        'pub_' +
                        makeRoomCode()
                            .toLowerCase();

                    const room =
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
           PRIVATE CREATE
        ================================================= */

        socket.on(
            'createPrivateGame',
            numberOfPlayers => {

                const count =
                    Number(
                        numberOfPlayers
                    );

                if (
                    ![2, 3, 4]
                        .includes(count)
                ) {

                    socket.emit(
                        'roomError',
                        'Invalid player count.'
                    );

                    return;
                }

                removeFromQueues(
                    socket.id
                );

                const roomId =
                    makeRoomCode();

                const room =
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

                socket.data.roomId =
                    roomId;

                socket.data.playerId =
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
           PRIVATE JOIN
        ================================================= */

        socket.on(
            'joinPrivateGame',
            rawCode => {

                const roomId =
                    String(
                        rawCode || ''
                    )
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

                removeFromQueues(
                    socket.id
                );

                room.sockets.push(
                    socket
                );

                socket.data.roomId =
                    roomId;

                socket.data.playerId =
                    null;

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


        /* =================================================
           DICE
        ================================================= */

        socket.on(
            'requestRoll',
            () => {

                const room =
                    getRoom(socket);

                if (
                    !room ||
                    !room.started ||
                    room.finished
                ) {
                    return;
                }

                const player =
                    getCurrentPlayer(room);

                if (!player) return;


                if (
                    Number(
                        socket.data.playerId
                    ) !== player.id
                ) {

                    socket.emit(
                        'actionError',
                        'It is not your turn.'
                    );

                    return;
                }


                if (!room.canRoll) {

                    socket.emit(
                        'actionError',
                        'You cannot roll right now.'
                    );

                    return;
                }


                /*
                   Use the extra-roll permission
                   from an earlier lucky 4/8.
                */

                const permission =
                    room.pendingRolls.find(
                        r =>
                            r.extraAvailable
                    );

                if (
                    room.pendingRolls.length &&
                    permission
                ) {

                    permission.extraAvailable =
                        false;
                }


                const roll =
                    rollDiceValue();


                const rollObject = {

                    value:
                        roll,

                    extraAvailable:
                        roll === 4 ||
                        roll === 8
                };


                room.pendingRolls.push(
                    rollObject
                );


                room.canRoll =
                    rollObject.extraAvailable;


                io.to(room.id).emit(
                    'diceRolled',
                    {
                        playerId:
                            player.id,

                        value:
                            roll
                    }
                );


                /* -----------------------------------------
                   NO VALID MOVE
                ----------------------------------------- */

                if (
                    !hasValidMove(
                        player,
                        roll
                    )
                ) {

                    room.pendingRolls.pop();


                    if (
                        roll === 4 ||
                        roll === 8
                    ) {

                        room.canRoll =
                            true;

                        sendMessage(
                            room,
                            `${player.name} rolled ${roll}. No valid move — lucky extra roll!`
                        );

                        sendState(room);

                        return;
                    }


                    room.canRoll =
                        false;


                    /*
                       If another stored dice number
                       exists, keep the turn.
                    */

                    if (
                        room.pendingRolls.length
                    ) {

                        sendMessage(
                            room,
                            `${player.name} rolled ${roll}. No valid move — choose another stored number.`
                        );

                        sendState(room);

                        return;
                    }


                    sendMessage(
                        room,
                        `${player.name} rolled ${roll}. No valid move.`
                    );


                    room.active =
                        nextActive(room);

                    room.canRoll = true;


                    const next =
                        getCurrentPlayer(room);

                    if (next) {

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
                    `${player.name} rolled ${roll}${
                        roll === 4 ||
                        roll === 8
                            ? ' 🍀 Lucky!'
                            : ''
                    }.`
                );


                sendState(room);
            }
        );


        /* =================================================
           MOVE
        ================================================= */

        socket.on(
            'requestMove',
            data => {

                const room =
                    getRoom(socket);

                if (
                    !room ||
                    !room.started ||
                    room.finished
                ) {
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

                const rollIndex =
                    Number(
                        data?.rollIndex
                    );


                const player =
                    getCurrentPlayer(room);


                if (
                    !player ||
                    Number(
                        socket.data.playerId
                    ) !== playerId ||
                    player.id !== playerId
                ) {

                    socket.emit(
                        'actionError',
                        'You cannot control this player.'
                    );

                    return;
                }


                if (
                    !Number.isInteger(
                        rollIndex
                    ) ||
                    rollIndex < 0 ||
                    rollIndex >=
                        room.pendingRolls.length
                ) {

                    socket.emit(
                        'actionError',
                        'Choose a dice number first.'
                    );

                    return;
                }


                const rollObject =
                    room.pendingRolls[
                        rollIndex
                    ];

                const roll =
                    rollObject.value;


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
                    player.pawns[
                        pawnIndex
                    ];

                const to =
                    from + roll;


                room.pendingRolls.splice(
                    rollIndex,
                    1
                );


                player.pawns[
                    pawnIndex
                ] = to;


                /* =================================================
                   CAPTURE
                   ONLY ONE PAWN CAN BE CAPTURED
                ================================================= */

                let captureHappened =
                    false;

                const captured = [];

                const boardCell =
                    to < 24
                        ? PATHS[
                            player.id
                          ][to]
                        : null;


                if (
                    to < 24 &&
                    !SAFE.includes(
                        boardCell
                    )
                ) {

                    /*
                       IMPORTANT:
                       Stop immediately after ONE pawn
                       is captured.

                       Therefore, if an opponent has
                       2, 3 or 4 pawns on the same square,
                       only ONE is sent back to start.
                    */

                    outerCapture:
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

                            const step =
                                opponent.pawns[j];


                            if (
                                step < 24 &&
                                PATHS[
                                    opponent.id
                                ][step] ===
                                boardCell
                            ) {

                                /*
                                   Capture exactly
                                   ONE pawn.
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


                                /*
                                   STOP ALL
                                   CAPTURE LOOPS
                                */

                                break outerCapture;
                            }
                        }
                    }
                }


                if (
                    captureHappened
                ) {

                    player.hasKilled =
                        true;
                }


                /* =================================================
                   HOME
                ================================================= */

                const reachedHome =
                    to === 24;


                if (
                    player.pawns.every(
                        step =>
                            step === 24
                    )
                ) {

                    player.hasWon =
                        true;

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

                let extraTurn =
                    false;


                /*
                   Lucky 4 / 8
                */

                if (
                    rollObject.extraAvailable
                ) {

                    extraTurn =
                        true;
                }


                /*
                   Capture
                */

                if (
                    captureHappened
                ) {

                    extraTurn =
                        true;
                }


                /*
                   HOME
                */

                if (
                    reachedHome &&
                    !player.hasWon
                ) {

                    extraTurn =
                        true;
                }


                /*
                   Finished player does
                   not get another turn.
                */

                if (
                    player.hasWon
                ) {

                    extraTurn =
                        false;
                }


                /* =================================================
                   GAME END
                ================================================= */

                if (
                    player.hasWon
                ) {

                    checkGameFinished(
                        room
                    );

                    extraTurn =
                        false;
                }


                /* =================================================
                   NEXT TURN
                ================================================= */

                if (
                    !room.finished
                ) {

                    if (
                        extraTurn
                    ) {

                        room.canRoll =
                            true;


                        if (
                            captureHappened
                        ) {

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
                                `${player.name} used ${roll} — extra roll!`
                            );
                        }


                    } else if (
                        room.pendingRolls.length
                    ) {

                        room.canRoll =
                            false;

                        sendMessage(
                            room,
                            `${player.name} still has a stored dice number to use.`
                        );


                    } else {

                        room.active =
                            nextActive(room);

                        room.canRoll =
                            true;


                        const nextPlayer =
                            getCurrentPlayer(
                                room
                            );

                        if (
                            nextPlayer
                        ) {

                            sendMessage(
                                room,
                                `${nextPlayer.name}'s turn.`
                            );
                        }
                    }
                }


                /* =================================================
                   SEND MOVE RESULT
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


                if (
                    room.finished
                ) {

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
            data => {

                const room =
                    getRoom(socket);

                if (!room) return;


                const player =
                    room.players.find(
                        p =>
                            p.id ===
                            socket.data.playerId
                    );


                if (!player) return;


                const text =
                    String(
                        data?.text || ''
                    )
                    .trim()
                    .slice(0, 300);


                if (!text) return;


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
           VOICE / MIC
        ================================================= */

        socket.on(
            'voiceJoin',
            () => {

                const room =
                    getRoom(socket);

                if (!room) return;


                const peers =
                    room.sockets
                        .filter(
                            s =>
                                s !== socket
                        )
                        .map(
                            s =>
                                s.id
                        );


                socket.emit(
                    'voicePeers',
                    peers
                );
            }
        );


        socket.on(
            'voiceLeave',
            () => {

                const room =
                    getRoom(socket);

                if (!room) return;


                room.sockets.forEach(
                    other => {

                        if (
                            other !== socket
                        ) {

                            other.emit(
                                'voicePeerLeft',
                                {
                                    socketId:
                                        socket.id
                                }
                            );
                        }
                    }
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
                    !data?.to
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


        /* =================================================
           DISCONNECT
        ================================================= */

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

                if (!room) return;


                room.sockets.forEach(
                    other => {

                        if (
                            other !== socket
                        ) {

                            other.emit(
                                'voicePeerLeft',
                                {
                                    socketId:
                                        socket.id
                                }
                            );
                        }
                    }
                );


                closeRoom(
                    room.id,
                    'A player disconnected. The match has ended.'
                );
            }
        );

    }
);


/* =========================================================
   START SERVER
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
