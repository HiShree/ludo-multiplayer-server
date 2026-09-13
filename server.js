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


// =====================================================
// BOARD
// =====================================================

const FINISH_STEP = 24;

const playerInfo = [
    {
        id: 0,
        name: "Blue",
        color: "#3498db",
        path: [
            10, 15, 20, 21, 22,
            23, 24, 19, 14, 9,
            4, 3, 2, 1, 0,
            5, 6, 7, 8, 13,
            18, 17, 16, 11, 12
        ]
    },

    {
        id: 1,
        name: "Red",
        color: "#e74c3c",
        path: [
            2, 1, 0, 5, 10,
            15, 20, 21, 22, 23,
            24, 19, 14, 9, 4,
            3, 8, 13, 18, 17,
            16, 11, 6, 7, 12
        ]
    },

    {
        id: 2,
        name: "Green",
        color: "#2ecc71",
        path: [
            14, 9, 4, 3, 2,
            1, 0, 5, 10, 15,
            20, 21, 22, 23, 24,
            19, 18, 17, 16, 11,
            6, 7, 8, 13, 12
        ]
    },

    {
        id: 3,
        name: "Yellow",
        color: "#f1c40f",
        path: [
            22, 23, 24, 19, 14,
            9, 4, 3, 2, 1,
            0, 5, 10, 15, 20,
            21, 16, 11, 6, 7,
            8, 13, 18, 17, 12
        ]
    }
];


// =====================================================
// ROOMS
// =====================================================

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = {};


// =====================================================
// PLAYER
// =====================================================

function createPlayer(id) {

    return {
        id: id,
        name: playerInfo[id].name,
        color: playerInfo[id].color,

        pawns: [0, 0, 0, 0],

        hasKilled: false,
        hasWon: false,
        winRank: null
    };
}


// =====================================================
// ROOM
// =====================================================

function createRoom(id, maxPlayers, isPrivate) {

    return {
        id: id,
        maxPlayers: maxPlayers,
        isPrivate: isPrivate,

        sockets: [],
        players: [],

        started: false,

        activeIndex: 0,

        activeRolls: [],

        canRoll: false,

        diceValues: [
            null,
            null,
            null,
            null
        ],

        currentRank: 1
    };
}


// =====================================================
// HELPERS
// =====================================================

function getRoom(socket) {

    if (!socket.gameRoom) {
        return null;
    }

    return rooms[socket.gameRoom] || null;
}


function getCurrentPlayer(room) {

    if (!room) {
        return null;
    }

    return room.players[room.activeIndex] || null;
}


function sendState(room) {

    if (!room) {
        return;
    }

    io.to(room.id).emit("gameState", {
        players: room.players,
        activeIndex: room.activeIndex,
        activeRolls: room.activeRolls,
        canRoll: room.canRoll,
        diceValues: room.diceValues,
        currentRank: room.currentRank
    });
}


function sendStatus(room, text) {

    if (!room) {
        return;
    }

    io.to(room.id).emit(
        "statusMessage",
        text
    );
}


function removeFromQueues(socketId) {

    for (const count of [2, 3, 4]) {

        publicQueues[count] =
            publicQueues[count].filter(
                id => id !== socketId
            );
    }
}


function generateRoomCode() {

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {

        code = "";

        for (let i = 0; i < 6; i++) {

            code += chars[
                Math.floor(
                    Math.random() *
                    chars.length
                )
            ];
        }

    } while (rooms[code]);

    return code;
}


// =====================================================
// TURN
// =====================================================

function nextPlayer(room) {

    if (!room || room.players.length === 0) {
        return;
    }

    const total = room.players.length;

    for (let i = 1; i <= total; i++) {

        const next =
            (room.activeIndex + i) % total;

        const player =
            room.players[next];

        if (
            player &&
            !player.hasWon
        ) {

            room.activeIndex = next;

            return;
        }
    }
}


function startNewTurn(room) {

    room.activeRolls = [];

    room.canRoll = true;

    room.diceValues =
        [null, null, null, null];

    const player =
        getCurrentPlayer(room);

    if (player) {

        sendStatus(
            room,
            `${player.name}'s turn.`
        );
    }

    sendState(room);
}


// =====================================================
// VALID MOVE
// =====================================================

function hasValidMove(player, roll) {

    if (!player) {
        return false;
    }

    return player.pawns.some(
        step =>
            step + roll <= FINISH_STEP
    );
}


// =====================================================
// START ROOM
// =====================================================

function setupRoom(room) {

    room.started = true;

    room.players = [];

    room.sockets.forEach(
        (socket, index) => {

            socket.playerIndex = index;
            socket.gameRoom = room.id;

            socket.join(room.id);

            const player =
                createPlayer(index);

            room.players.push(player);

            socket.emit(
                "assignPlayer",
                {
                    playerId: index,
                    playerName: player.name
                }
            );
        }
    );


    room.activeIndex = 0;

    room.activeRolls = [];

    room.canRoll = true;

    room.diceValues =
        [null, null, null, null];

    room.currentRank = 1;


    io.to(room.id).emit(
        "gameStart",
        {
            players: room.players,
            activeIndex: 0
        }
    );


    sendStatus(
        room,
        "Match started! Blue goes first."
    );

    sendState(room);
}


// =====================================================
// CLOSE ROOM
// =====================================================

function closeRoom(room) {

    if (!room) {
        return;
    }

    room.sockets.forEach(socket => {

        socket.leave(room.id);

        socket.gameRoom = null;
        socket.playerIndex = null;

        socket.emit("roomClosed");
    });

    delete rooms[room.id];
}


// =====================================================
// CONNECTION
// =====================================================

io.on("connection", socket => {

    console.log(
        "Player connected:",
        socket.id
    );


    // =================================================
    // PUBLIC GAME
    // =================================================

    socket.on(
        "joinGame",
        count => {

            count = Number(count);

            if (
                ![2, 3, 4].includes(count)
            ) {

                socket.emit(
                    "statusMessage",
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
                `Searching for ${count} players...`
            );


            if (
                publicQueues[count].length >= count
            ) {

                const ids =
                    publicQueues[count]
                        .splice(0, count);


                const roomId =
                    "pub_" +
                    Math.random()
                        .toString(36)
                        .substring(2, 10);


                const room =
                    createRoom(
                        roomId,
                        count,
                        false
                    );


                rooms[roomId] = room;


                ids.forEach(id => {

                    const playerSocket =
                        io.sockets.sockets.get(id);

                    if (playerSocket) {

                        room.sockets.push(
                            playerSocket
                        );
                    }
                });


                if (
                    room.sockets.length === count
                ) {

                    setupRoom(room);

                } else {

                    closeRoom(room);
                }
            }
        }
    );


    // =================================================
    // CREATE PRIVATE ROOM
    // =================================================

    socket.on(
        "createPrivateGame",
        count => {

            count = Number(count);

            if (
                ![2, 3, 4].includes(count)
            ) {

                socket.emit(
                    "roomError",
                    "Invalid player count."
                );

                return;
            }


            const code =
                generateRoomCode();


            const room =
                createRoom(
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
                code
            );


            socket.emit(
                "statusMessage",
                `Private room created: ${code}`
            );
        }
    );


    // =================================================
    // JOIN PRIVATE ROOM
    // =================================================

    socket.on(
        "joinPrivateGame",
        code => {

            code =
                String(code || "")
                    .trim()
                    .toUpperCase();


            const room =
                rooms[code];


            if (!room) {

                socket.emit(
                    "roomError",
                    "Room not found."
                );

                return;
            }


            if (room.started) {

                socket.emit(
                    "roomError",
                    "Game has already started."
                );

                return;
            }


            if (
                room.sockets.length >=
                room.maxPlayers
            ) {

                socket.emit(
                    "roomError",
                    "Room is full."
                );

                return;
            }


            room.sockets.push(socket);

            socket.gameRoom = room.id;

            socket.playerIndex = null;

            socket.join(room.id);


            io.to(room.id).emit(
                "statusMessage",
                `Player joined: ${room.sockets.length}/${room.maxPlayers}`
            );


            if (
                room.sockets.length ===
                room.maxPlayers
            ) {

                setupRoom(room);
            }
        }
    );


    // =================================================
    // ROLL
    // =================================================

    socket.on(
        "requestRoll",
        () => {

            const room =
                getRoom(socket);


            if (
                !room ||
                !room.started
            ) {
                return;
            }


            const player =
                getCurrentPlayer(room);


            if (!player) {
                return;
            }


            if (
                socket.playerIndex !==
                room.activeIndex
            ) {

                socket.emit(
                    "statusMessage",
                    "It is not your turn."
                );

                return;
            }


            if (!room.canRoll) {
                return;
            }


            if (
                room.activeRolls.length > 0
            ) {
                return;
            }


            const dicePool =
                [1, 1, 2, 2, 3, 3, 4, 8];


            const roll =
                dicePool[
                    Math.floor(
                        Math.random() *
                        dicePool.length
                    )
                ];


            room.diceValues[
                room.activeIndex
            ] = roll;


            room.activeRolls.push(roll);

            room.canRoll = false;


            io.to(room.id).emit(
                "diceRolled",
                {
                    playerId:
                        room.activeIndex,

                    value:
                        roll
                }
            );


            // -----------------------------------------
            // NO MOVE
            // -----------------------------------------

            if (
                !hasValidMove(
                    player,
                    roll
                )
            ) {

                room.activeRolls.shift();


                // 4 and 8 always give another roll
                if (
                    roll === 4 ||
                    roll === 8
                ) {

                    room.canRoll = true;

                    sendStatus(
                        room,
                        `${player.name} rolled ${roll}. Roll again!`
                    );

                    sendState(room);

                    return;
                }


                nextPlayer(room);

                startNewTurn(room);

                return;
            }


            sendStatus(
                room,
                `${player.name} rolled ${roll}. Choose a pawn.`
            );

            sendState(room);
        }
    );


    // =================================================
    // MOVE
    // =================================================

    socket.on(
        "requestMove",
        data => {

            const room =
                getRoom(socket);


            if (
                !room ||
                !room.started
            ) {
                return;
            }


            const playerId =
                Number(data.playerId);

            const pawnIndex =
                Number(data.pawnIndex);


            if (
                socket.playerIndex !==
                playerId
            ) {
                return;
            }


            if (
                room.activeIndex !==
                playerId
            ) {
                return;
            }


            const player =
                room.players[playerId];


            if (!player) {
                return;
            }


            if (
                pawnIndex < 0 ||
                pawnIndex > 3
            ) {
                return;
            }


            if (
                room.activeRolls.length === 0
            ) {
                return;
            }


            const roll =
                room.activeRolls[0];


            const oldStep =
                player.pawns[pawnIndex];


            const newStep =
                oldStep + roll;


            if (
                newStep > FINISH_STEP
            ) {
                return;
            }


            room.activeRolls.shift();


            player.pawns[pawnIndex] =
                newStep;


            const targetCell =
                playerInfo[playerId]
                    .path[newStep];


            // -----------------------------------------
            // FINISH PAWN
            // -----------------------------------------

            const finishedPawn =
                newStep === FINISH_STEP;


            let playerWon = false;


            if (finishedPawn) {

                const allFinished =
                    player.pawns.every(
                        step =>
                            step === FINISH_STEP
                    );


                if (allFinished) {

                    player.hasWon = true;

                    player.winRank =
                        room.currentRank++;

                    playerWon = true;
                }
            }


            // -----------------------------------------
            // CAPTURE
            // -----------------------------------------

            const safeCells =
                [2, 10, 14, 22, 12];


            const captured = [];

            let capturedSomething = false;


            if (
                !safeCells.includes(
                    targetCell
                ) &&
                newStep < FINISH_STEP
            ) {

                room.players.forEach(
                    opponent => {

                        if (
                            opponent.id ===
                            player.id
                        ) {
                            return;
                        }


                        opponent.pawns =
                            opponent.pawns.map(
                                opponentStep => {

                                    if (
                                        opponentStep === 0 ||
                                        opponentStep === FINISH_STEP
                                    ) {
                                        return opponentStep;
                                    }


                                    const opponentCell =
                                        playerInfo[
                                            opponent.id
                                        ].path[
                                            opponentStep
                                        ];


                                    if (
                                        opponentCell ===
                                        targetCell
                                    ) {

                                        captured.push(
                                            {
                                                playerId:
                                                    opponent.id
                                            }
                                        );

                                        capturedSomething =
                                            true;

                                        return 0;
                                    }


                                    return opponentStep;
                                }
                            );
                    }
                );
            }


            if (capturedSomething) {

                player.hasKilled = true;
            }


            // -----------------------------------------
            // EXTRA TURN
            // -----------------------------------------

            const extraTurn =
                roll === 4 ||
                roll === 8 ||
                capturedSomething ||
                finishedPawn;


            const remaining =
                room.players.filter(
                    p => !p.hasWon
                );


            io.to(room.id).emit(
                "moveResult",
                {
                    playerId,
                    pawnIndex,
                    oldStep,
                    newStep,
                    roll,
                    targetCell,
                    captured,
                    playerWon,
                    extraTurn
                }
            );


            // -----------------------------------------
            // GAME FINISHED
            // -----------------------------------------

            if (
                playerWon &&
                remaining.length <= 1
            ) {

                room.canRoll = false;

                sendState(room);

                io.to(room.id).emit(
                    "gameFinished",
                    {
                        winner:
                            player.id
                    }
                );

                return;
            }


            // -----------------------------------------
            // EXTRA TURN
            // -----------------------------------------

            if (extraTurn) {

                room.activeRolls = [];

                room.canRoll = true;

                room.diceValues[
                    room.activeIndex
                ] = null;


                sendStatus(
                    room,
                    `${player.name} gets another roll!`
                );


                sendState(room);

                return;
            }


            // -----------------------------------------
            // NORMAL NEXT TURN
            // -----------------------------------------

            nextPlayer(room);

            startNewTurn(room);
        }
    );


    // =================================================
    // CHAT
    // =================================================

    socket.on(
        "sendChatMessage",
        message => {

            const room =
                getRoom(socket);

            if (!room) {
                return;
            }


            const text =
                String(message || "")
                    .trim()
                    .substring(0, 200);


            if (!text) {
                return;
            }


            const player =
                room.players[
                    socket.playerIndex
                ];


            if (!player) {
                return;
            }


            // ONLY PLAYER CHAT
            io.to(room.id).emit(
                "receiveChatMessage",
                {
                    playerId:
                        player.id,

                    playerName:
                        player.name,

                    message:
                        text
                }
            );
        }
    );


    // =================================================
    // VOICE CHAT RELAY
    // =================================================

    socket.on(
        "voiceOffer",
        data => {

            const room =
                getRoom(socket);

            if (!room) {
                return;
            }


            const target =
                room.sockets[
                    Number(data.target)
                ];


            if (!target) {
                return;
            }


            target.emit(
                "voiceOffer",
                {
                    from:
                        socket.playerIndex,

                    offer:
                        data.offer
                }
            );
        }
    );


    socket.on(
        "voiceAnswer",
        data => {

            const room =
                getRoom(socket);

            if (!room) {
                return;
            }


            const target =
                room.sockets[
                    Number(data.target)
                ];


            if (!target) {
                return;
            }


            target.emit(
                "voiceAnswer",
                {
                    from:
                        socket.playerIndex,

                    answer:
                        data.answer
                }
            );
        }
    );


    socket.on(
        "iceCandidate",
        data => {

            const room =
                getRoom(socket);

            if (!room) {
                return;
            }


            const target =
                room.sockets[
                    Number(data.target)
                ];


            if (!target) {
                return;
            }


            target.emit(
                "iceCandidate",
                {
                    from:
                        socket.playerIndex,

                    candidate:
                        data.candidate
                }
            );
        }
    );


    // =================================================
    // DISCONNECT
    // =================================================

    socket.on(
        "disconnect",
        () => {

            console.log(
                "Player disconnected:",
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


            closeRoom(room);
        }
    );
});


// =====================================================
// START
// =====================================================

server.listen(
    PORT,
    () => {

        console.log(
            `Ludo Twist running on port ${PORT}`
        );
    }
);
