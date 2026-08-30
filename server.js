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

const PORT = process.env.PORT || 3000;

app.use(
    express.static(
        path.join(__dirname)
    )
);

/* =========================================================
   GAME CONSTANTS
========================================================= */

const COLORS = [
    {
        id: 0,
        name: "Blue",
        color: "#0984e3"
    },
    {
        id: 1,
        name: "Red",
        color: "#d63031"
    },
    {
        id: 2,
        name: "Green",
        color: "#00b894"
    },
    {
        id: 3,
        name: "Yellow",
        color: "#fdcb6e"
    }
];

const PATHS = [
    [
        10,15,20,21,22,23,24,
        19,14,9,4,3,2,1,0,
        5,6,7,8,13,18,17,16,11
    ],

    [
        2,1,0,5,10,15,20,21,
        22,23,24,19,14,9,4,3,
        8,13,18,17,16,11,6,7
    ],

    [
        14,9,4,3,2,1,0,5,
        10,15,20,21,22,23,24,19,
        18,17,16,11,6,7,8,13
    ],

    [
        22,23,24,19,14,9,4,3,
        2,1,0,5,10,15,20,21,
        16,11,6,7,8,13,18,17
    ]
];

const SAFE_CELLS =
    [2,10,14,22,12];

/* =========================================================
   ROOMS
========================================================= */

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = new Map();

/* =========================================================
   HELPERS
========================================================= */

function createPlayer(id) {

    return {
        id,
        name: COLORS[id].name,
        color: COLORS[id].color,
        pawns: [0,0,0,0],
        hasWon: false,
        winRank: 0,
        socketId: null
    };
}

function createGameState(players) {

    return {
        players,
        turnIndex: 0,
        dice: null,
        canRoll: true,
        winner: null,
        moveNumber: 0
    };
}

function rollDice() {

    const values =
        [1,1,2,2,3,3,4,8];

    return values[
        Math.floor(
            Math.random() * values.length
        )
    ];
}

function getRoom(socket) {

    if(!socket.roomId)
        return null;

    return rooms.get(
        socket.roomId
    );
}

function sendState(room) {

    io.to(room.id).emit(
        "game:state",
        cleanState(room.state)
    );
}

function cleanState(state) {

    return {
        players:
            state.players.map(p => ({
                id: p.id,
                name: p.name,
                color: p.color,
                pawns: [...p.pawns],
                hasWon: p.hasWon,
                winRank: p.winRank,
                dice:
                    state.players[
                        state.turnIndex
                    ].id === p.id
                        ? state.dice
                        : null
            })),

        turnIndex:
            state.turnIndex,

        dice:
            state.dice,

        canRoll:
            state.canRoll,

        winner:
            state.winner,

        moveNumber:
            state.moveNumber
    };
}

function playerCanMove(
    player,
    roll
) {

    if(
        !player ||
        roll == null
    ) return false;

    return player.pawns.some(
        step =>
            step + roll <= 24
    );
}

function nextActivePlayer(room) {

    const state = room.state;

    for(
        let i = 1;
        i <= state.players.length;
        i++
    ) {

        const index =
            (
                state.turnIndex +
                i
            ) %
            state.players.length;

        if(
            !state.players[index].hasWon
        ) {

            state.turnIndex =
                index;

            return;
        }
    }

    state.winner = true;
}

function finishTurn(room) {

    const state = room.state;

    state.dice = null;

    state.canRoll = true;

    nextActivePlayer(room);
}

/* =========================================================
   CAPTURE
========================================================= */

function captureOpponents(
    room,
    movingPlayer,
    pawnIndex
) {

    const state = room.state;

    const step =
        movingPlayer.pawns[pawnIndex];

    const cell =
        PATHS[
            movingPlayer.id
        ][step];

    if(
        SAFE_CELLS.includes(cell)
    ) {

        return false;
    }

    let captured = false;

    state.players.forEach(
        opponent => {

            if(
                opponent.id ===
                movingPlayer.id
            ) return;

            if(opponent.hasWon)
                return;

            opponent.pawns.forEach(
                (opStep, index) => {

                    const opponentCell =
                        PATHS[
                            opponent.id
                        ][opStep];

                    if(
                        opStep < 24 &&
                        opponentCell === cell
                    ) {

                        opponent.pawns[index] = 0;

                        captured = true;
                    }
                }
            );
        }
    );

    return captured;
}

/* =========================================================
   CONNECTION
========================================================= */

io.on(
    "connection",
    socket => {

        console.log(
            "Connected:",
            socket.id
        );

        /* =================================================
           PUBLIC MATCHMAKING
        ================================================= */

        socket.on(
            "public:join",
            number => {

                number =
                    Number(number);

                if(
                    ![2,3,4]
                    .includes(number)
                ) {

                    socket.emit(
                        "room:error",
                        "Invalid player count."
                    );

                    return;
                }

                removeFromQueues(socket);

                publicQueues[number]
                    .push(socket);

                socket.emit(
                    "room:waiting",
                    {
                        count:
                            publicQueues[
                                number
                            ].length,
                        maxPlayers:
                            number
                    }
                );

                if(
                    publicQueues[number]
                        .length >= number
                ) {

                    const sockets =
                        publicQueues[number]
                            .splice(
                                0,
                                number
                            );

                    createRoom(
                        sockets,
                        number,
                        false,
                        null
                    );
                }
            }
        );

        /* =================================================
           PRIVATE CREATE
        ================================================= */

        socket.on(
            "private:create",
            number => {

                number =
                    Number(number);

                if(
                    ![2,3,4]
                    .includes(number)
                ) {

                    socket.emit(
                        "room:error",
                        "Invalid player count."
                    );

                    return;
                }

                removeFromQueues(socket);

                let code;

                do {

                    code =
                        Math.random()
                            .toString(36)
                            .substring(
                                2,
                                8
                            )
                            .toUpperCase();

                } while(rooms.has(code));

                const room = {
                    id: code,
                    private: true,
                    maxPlayers: number,
                    started: false,
                    sockets: [],
                    state: null
                };

                rooms.set(
                    code,
                    room
                );

                room.sockets.push(socket);

                socket.join(code);

                socket.roomId = code;

                socket.emit(
                    "player:assigned",
                    {
                        playerId: 0,
                        message:
                            "You are Blue. Waiting for players..."
                    }
                );

                socket.emit(
                    "room:created",
                    {
                        code
                    }
                );
            }
        );

        /* =================================================
           PRIVATE JOIN
        ================================================= */

        socket.on(
            "private:join",
            code => {

                code =
                    String(code)
                        .trim()
                        .toUpperCase();

                const room =
                    rooms.get(code);

                if(!room) {

                    socket.emit(
                        "room:error",
                        "Room code not found."
                    );

                    return;
                }

                if(room.started) {

                    socket.emit(
                        "room:error",
                        "Game has already started."
                    );

                    return;
                }

                if(
                    room.sockets.length >=
                    room.maxPlayers
                ) {

                    socket.emit(
                        "room:error",
                        "Room is full."
                    );

                    return;
                }

                removeFromQueues(socket);

                const playerId =
                    room.sockets.length;

                room.sockets.push(socket);

                socket.join(code);

                socket.roomId = code;

                socket.emit(
                    "player:assigned",
                    {
                        playerId,
                        message:
                            `You are ${COLORS[playerId].name}.`
                    }
                );

                io.to(code).emit(
                    "room:waiting",
                    {
                        count:
                            room.sockets.length,
                        maxPlayers:
                            room.maxPlayers
                    }
                );

                if(
                    room.sockets.length ===
                    room.maxPlayers
                ) {

                    startRoom(room);
                }
            }
        );

        /* =================================================
           ROLL
        ================================================= */

        socket.on(
            "game:roll",
            () => {

                const room =
                    getRoom(socket);

                if(
                    !room ||
                    !room.started
                ) return;

                const state =
                    room.state;

                const current =
                    state.players[
                        state.turnIndex
                    ];

                if(
                    current.socketId !==
                    socket.id
                ) {

                    return;
                }

                if(
                    !state.canRoll ||
                    state.dice !== null
                ) {

                    return;
                }

                const roll =
                    rollDice();

                state.dice = roll;

                /*
                   4 and 8 allow another roll
                   AFTER a successful move.
                   The current dice still has to
                   be moved first.
                */

                state.canRoll = false;

                state.moveNumber++;

                io.to(room.id).emit(
                    "game:message",
                    `${current.name} rolled ${roll}.`
                );

                sendState(room);

                /*
                   If nothing can move,
                   automatically finish the turn.
                */

                if(
                    !playerCanMove(
                        current,
                        roll
                    )
                ) {

                    setTimeout(
                        () => {

                            if(
                                state.dice !==
                                roll
                            ) return;

                            state.dice = null;

                            state.canRoll = true;

                            nextActivePlayer(room);

                            io.to(room.id).emit(
                                "game:message",
                                `${current.name} had no valid move. Turn passed.`
                            );

                            sendState(room);

                        },
                        700
                    );
                }
            }
        );

        /* =================================================
           MOVE
        ================================================= */

        socket.on(
            "game:move",
            data => {

                const room =
                    getRoom(socket);

                if(
                    !room ||
                    !room.started
                ) return;

                const state =
                    room.state;

                const current =
                    state.players[
                        state.turnIndex
                    ];

                if(
                    current.socketId !==
                    socket.id
                ) return;

                if(
                    state.dice === null
                ) return;

                const pawnIndex =
                    Number(
                        data?.pawnIndex
                    );

                if(
                    !Number.isInteger(
                        pawnIndex
                    ) ||
                    pawnIndex < 0 ||
                    pawnIndex > 3
                ) return;

                const oldStep =
                    current.pawns[
                        pawnIndex
                    ];

                const roll =
                    state.dice;

                const newStep =
                    oldStep + roll;

                if(
                    newStep > 24
                ) return;

                current.pawns[
                    pawnIndex
                ] = newStep;

                state.moveNumber++;

                let captured =
                    captureOpponents(
                        room,
                        current,
                        pawnIndex
                    );

                let reachedHome =
                    newStep === 24;

                let finished =
                    current.pawns.every(
                        x => x === 24
                    );

                if(finished) {

                    current.hasWon = true;

                    current.winRank =
                        state.players
                            .filter(
                                p => p.hasWon
                            )
                            .length;

                    io.to(room.id).emit(
                        "game:message",
                        `${current.name} finished! 🏆`
                    );
                }

                /*
                   Extra turn:
                   4
                   8
                   capture
                   reaching HOME
                */

                const extraTurn =
                    roll === 4 ||
                    roll === 8 ||
                    captured ||
                    reachedHome;

                state.dice = null;

                if(
                    finished &&
                    state.players.every(
                        p => p.hasWon
                    )
                ) {

                    state.winner = true;

                    io.to(room.id).emit(
                        "game:message",
                        "Game finished!"
                    );

                    sendState(room);

                    return;
                }

                if(
                    extraTurn &&
                    !finished
                ) {

                    state.canRoll = true;

                    io.to(room.id).emit(
                        "game:message",
                        `${current.name} gets an extra turn!`
                    );

                } else {

                    state.canRoll = true;

                    nextActivePlayer(room);
                }

                sendState(room);
            }
        );

        /* =================================================
           CHAT
        ================================================= */

        socket.on(
            "chat:send",
            data => {

                const room =
                    getRoom(socket);

                if(!room)
                    return;

                const player =
                    room.state?.players
                        .find(
                            p =>
                                p.socketId ===
                                socket.id
                        );

                if(!player)
                    return;

                const text =
                    String(
                        data?.text || ""
                    )
                    .trim()
                    .substring(0,120);

                if(!text)
                    return;

                io.to(room.id).emit(
                    "chat:receive",
                    {
                        name:
                            player.name,
                        text
                    }
                );
            }
        );

        /* =================================================
           VOICE SIGNALING
        ================================================= */

        socket.on(
            "voice:ready",
            () => {

                const room =
                    getRoom(socket);

                if(!room)
                    return;

                room.sockets.forEach(
                    other => {

                        if(
                            other.id !==
                            socket.id
                        ) {

                            socket.emit(
                                "voice:peer",
                                other.id
                            );
                        }
                    }
                );
            }
        );

        socket.on(
            "voice:start",
            () => {

                const room =
                    getRoom(socket);

                if(!room)
                    return;

                socket.to(room.id).emit(
                    "voice:peer",
                    socket.id
                );
            }
        );

        socket.on(
            "voice:offer",
            data => {

                if(!data?.to)
                    return;

                io.to(data.to).emit(
                    "voice:offer",
                    {
                        from:
                            socket.id,
                        offer:
                            data.offer
                    }
                );
            }
        );

        socket.on(
            "voice:answer",
            data => {

                if(!data?.to)
                    return;

                io.to(data.to).emit(
                    "voice:answer",
                    {
                        from:
                            socket.id,
                        answer:
                            data.answer
                    }
                );
            }
        );

        socket.on(
            "voice:ice",
            data => {

                if(!data?.to)
                    return;

                io.to(data.to).emit(
                    "voice:ice",
                    {
                        from:
                            socket.id,
                        candidate:
                            data.candidate
                    }
                );
            }
        );

        socket.on(
            "voice:stop",
            () => {

                const room =
                    getRoom(socket);

                if(!room)
                    return;

                socket.to(room.id).emit(
                    "voice:stop-peer",
                    socket.id
                );
            }
        );

        /* =================================================
           DISCONNECT
        ================================================= */

        socket.on(
            "disconnect",
            () => {

                console.log(
                    "Disconnected:",
                    socket.id
                );

                removeFromQueues(socket);

                const room =
                    getRoom(socket);

                if(!room)
                    return;

                socket.to(room.id).emit(
                    "voice:stop-peer",
                    socket.id
                );

                room.sockets =
                    room.sockets.filter(
                        s =>
                            s.id !==
                            socket.id
                    );

                /*
                   If the game hasn't started,
                   keep the room available.
                */

                if(!room.started) {

                    if(
                        room.sockets.length ===
                        0
                    ) {

                        rooms.delete(
                            room.id
                        );
                    }

                    return;
                }

                /*
                   During a game, remove the
                   disconnected player.
                */

                const disconnectedPlayer =
                    room.state.players.find(
                        p =>
                            p.socketId ===
                            socket.id
                    );

                if(
                    disconnectedPlayer
                ) {

                    disconnectedPlayer.hasWon =
                        true;

                    if(
                        room.state.players[
                            room.state.turnIndex
                        ].socketId ===
                        socket.id
                    ) {

                        nextActivePlayer(room);
                    }

                    sendState(room);
                }
            }
        );
    }
);

/* =========================================================
   ROOM CREATION
========================================================= */

function createRoom(
    sockets,
    number,
    isPrivate,
    id
) {

    const roomId =
        id ||
        "public_" +
        Math.random()
            .toString(36)
            .substring(2,8);

    const players =
        sockets.map(
            (socket,index) => {

                const player =
                    createPlayer(index);

                player.socketId =
                    socket.id;

                socket.join(roomId);

                socket.roomId =
                    roomId;

                socket.playerId =
                    index;

                socket.emit(
                    "player:assigned",
                    {
                        playerId:index,
                        message:
                            `You are ${player.name}.`
                    }
                );

                return player;
            }
        );

    const room = {
        id: roomId,
        private: isPrivate,
        maxPlayers: number,
        started: false,
        sockets: [...sockets],
        state:
            createGameState(players)
    };

    rooms.set(
        roomId,
        room
    );

    startRoom(room);
}

/* =========================================================
   START ROOM
========================================================= */

function startRoom(room) {

    room.started = true;

    room.state =
        createGameState(
            room.sockets.map(
                (socket,index) => {

                    const player =
                        createPlayer(index);

                    player.socketId =
                        socket.id;

                    socket.playerId =
                        index;

                    return player;
                }
            )
        );

    room.sockets.forEach(
        (socket,index) => {

            socket.emit(
                "player:assigned",
                {
                    playerId:index,
                    message:
                        `You are ${COLORS[index].name}.`
                }
            );
        }
    );

    io.to(room.id).emit(
        "game:start",
        cleanState(room.state)
    );

    io.to(room.id).emit(
        "game:message",
        "Match started! Blue goes first."
    );

    console.log(
        "Game started:",
        room.id
    );
}

/* =========================================================
   QUEUE CLEANUP
========================================================= */

function removeFromQueues(socket) {

    Object.keys(
        publicQueues
    ).forEach(number => {

        publicQueues[number] =
            publicQueues[number]
                .filter(
                    s =>
                        s.id !==
                        socket.id
                );
    });
}

/* =========================================================
   SERVER
========================================================= */

server.listen(
    PORT,
    () => {

        console.log(
            `Ludo Twist server running on port ${PORT}`
        );
    }
);
