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

app.use(express.static(path.join(__dirname)));

/* =========================================================
   LUDO TWIST SERVER
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
        id,
        name: NAMES[id],
        color: COLORS[id],
        pawns: [0,0,0,0],
        hasKilled: false,
        hasWon: false,
        rank: 0,
        lastRoll: null
    };
}

/* =========================================================
   ROOM
========================================================= */

function makeRoom(id, maxPlayers, isPrivate) {
    return {
        id,
        maxPlayers,
        isPrivate,

        sockets: [],
        players: [],

        started: false,
        finished: false,

        active: 0,

        pendingRolls: [],

        canRoll: true,
        rollPermissionIndex: -1,

        rank: 1
    };
}

/* =========================================================
   HELPERS
========================================================= */

function getRoom(socket) {
    const roomId = socket.data.roomId;

    if (!roomId) {
        return null;
    }

    return rooms.get(roomId) || null;
}

function getCurrentPlayer(room) {
    if (!room || !room.players.length) {
        return null;
    }

    return room.players[room.active];
}

function removeFromQueues(socketId) {
    for (const count of [2,3,4]) {
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
            .slice(2,8)
            .toUpperCase();
    } while (rooms.has(code));

    return code;
}

/* =========================================================
   NEXT PLAYER
========================================================= */

function nextActive(room) {
    if (!room || !room.players.length) {
        return 0;
    }

    for (
        let step = 1;
        step <= room.players.length;
        step++
    ) {
        const index =
            (room.active + step) %
            room.players.length;

        const player = room.players[index];

        if (player && !player.hasWon) {
            return index;
        }
    }

    return room.active;
}

/* =========================================================
   MOVEMENT
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

    const step = player.pawns[pawnIndex];

    if (step >= 24) {
        return false;
    }

    const maximum =
        player.hasKilled ? 24 : 15;

    return step + roll <= maximum;
}

function hasValidMove(player, roll) {
    return player.pawns.some(
        (_, index) =>
            isValidMove(player, index, roll)
    );
}

/* =========================================================
   BOARD
========================================================= */

function getBoardCell(playerId, step) {
    return PATHS[playerId][step];
}

/* =========================================================
   CAPTURE
   IMPORTANT:
   ONLY ONE OPPONENT PAWN IS CAPTURED
========================================================= */

function performCapture(room, player, to) {

    const captured = [];

    if (to >= 24) {
        return captured;
    }

    const cell =
        getBoardCell(player.id, to);

    if (SAFE.includes(cell)) {
        return captured;
    }

    /*
       Find the FIRST opponent pawn on the
       destination square and capture ONLY that one.
    */

    for (const opponent of room.players) {

        if (
            opponent.id === player.id ||
            opponent.hasWon
        ) {
            continue;
        }

        for (let i = 0; i < 4; i++) {

            const step = opponent.pawns[i];

            if (step >= 24) {
                continue;
            }

            const opponentCell =
                getBoardCell(opponent.id, step);

            if (opponentCell === cell) {

                opponent.pawns[i] = 0;

                captured.push({
                    playerId: opponent.id,
                    pawnIndex: i
                });

                /*
                   STOP IMMEDIATELY.
                   No second opponent pawn is captured.
                */

                return captured;
            }
        }
    }

    return captured;
}

/* =========================================================
   PUBLIC STATE
========================================================= */

function getPublicState(room) {

    return {
        active: room.active,

        pendingRolls:
            room.pendingRolls.map(die => ({
                id: die.id,
                value: die.value,
                extraAvailable:
                    die.extraAvailable
            })),

        canRoll: room.canRoll,

        rank: room.rank,

        finished: room.finished,

        players:
            room.players.map(player => ({
                id: player.id,
                name: player.name,
                color: player.color,

                pawns: [...player.pawns],

                hasKilled:
                    player.hasKilled,

                hasWon:
                    player.hasWon,

                rank:
                    player.rank,

                lastRoll:
                    player.lastRoll
            }))
    };
}

function sendState(room) {

    if (!room) {
        return;
    }

    io.to(room.id).emit(
        "gameState",
        getPublicState(room)
    );
}

function sendMessage(room, message) {

    if (!room) {
        return;
    }

    /*
       System messages are sent only as status.
       They are NOT sent to chat.
    */

    io.to(room.id).emit(
        "systemMessage",
        message
    );
}

/* =========================================================
   GAME FINISHED
========================================================= */

function checkGameFinished(room) {

    const remaining =
        room.players.filter(
            player => !player.hasWon
        );

    if (remaining.length <= 1) {

        if (remaining.length === 1) {

            const last =
                remaining[0];

            last.hasWon = true;

            last.rank =
                room.rank++;
        }

        room.finished = true;

        room.canRoll = false;

        room.pendingRolls = [];

        room.rollPermissionIndex = -1;

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

    room.sockets = [...sockets];

    room.players = [];

    room.started = true;

    room.finished = false;

    room.active = 0;

    room.pendingRolls = [];

    room.canRoll = true;

    room.rollPermissionIndex = -1;

    room.rank = 1;

    sockets.forEach((socket, index) => {

        const playerId = index;

        socket.data.roomId = roomId;

        socket.data.playerId = playerId;

        socket.join(roomId);

        room.players.push(
            makePlayer(playerId)
        );

        socket.emit(
            "assignPlayer",
            {
                playerId,
                playerName:
                    NAMES[playerId]
            }
        );
    });

    io.to(roomId).emit(
        "gameStart",
        {
            players:
                room.players.map(
                    player => player.id
                )
        }
    );

    sendMessage(
        room,
        "🎮 Match started! Blue goes first."
    );

    sendState(room);
}

/* =========================================================
   CLOSE ROOM
========================================================= */

function closeRoom(roomId, message) {

    const room =
        rooms.get(roomId);

    if (!room) {
        return;
    }

    io.to(roomId).emit(
        "roomClosed",
        message ||
        "Room closed."
    );

    room.sockets.forEach(socket => {

        socket.leave(roomId);

        socket.data.roomId = null;

        socket.data.playerId = null;
    });

    rooms.delete(roomId);
}

/* =========================================================
   CONNECTION
========================================================= */

io.on("connection", socket => {

    console.log(
        "Connected:",
        socket.id
    );

    /* =====================================================
       PUBLIC GAME
    ===================================================== */

    socket.on(
        "joinGame",
        numberOfPlayers => {

            const count =
                Number(numberOfPlayers);

            if (![2,3,4].includes(count)) {

                socket.emit(
                    "roomError",
                    "Invalid player count."
                );

                return;
            }

            removeFromQueues(
                socket.id
            );

            queues[count].push(socket);

            socket.emit(
                "systemMessage",
                `Waiting for ${
                    count - queues[count].length
                } more player(s)...`
            );

            if (queues[count].length >= count) {

                const matched =
                    queues[count]
                        .splice(0,count);

                const roomId =
                    "pub_" +
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

    /* =====================================================
       PRIVATE GAME
    ===================================================== */

    socket.on(
        "createPrivateGame",
        numberOfPlayers => {

            const count =
                Number(numberOfPlayers);

            if (![2,3,4].includes(count)) {

                socket.emit(
                    "roomError",
                    "Invalid player count."
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
                "privateRoomCreated",
                roomId
            );

            sendMessage(
                room,
                `Room created. Share code ${roomId}.`
            );
        }
    );

    socket.on(
        "joinPrivateGame",
        rawCode => {

            const roomId =
                String(rawCode || "")
                    .trim()
                    .toUpperCase();

            const room =
                rooms.get(roomId);

            if (!room) {

                socket.emit(
                    "roomError",
                    "Room code not found!"
                );

                return;
            }

            if (room.started) {

                socket.emit(
                    "roomError",
                    "Game has already started!"
                );

                return;
            }

            if (
                room.sockets.length >=
                room.maxPlayers
            ) {

                socket.emit(
                    "roomError",
                    "Room is full!"
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
                `Player joined (${room.sockets.length}/${room.maxPlayers}).`
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
       ROLL
    ===================================================== */

    socket.on(
        "requestRoll",
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

            if (!player) {
                return;
            }

            if (
                Number(socket.data.playerId) !==
                player.id
            ) {

                socket.emit(
                    "actionError",
                    "It is not your turn."
                );

                return;
            }

            if (!room.canRoll) {

                socket.emit(
                    "actionError",
                    "Roll is not available yet."
                );

                return;
            }

            if (
                room.rollPermissionIndex >= 0 &&
                room.pendingRolls[
                    room.rollPermissionIndex
                ]
            ) {

                room.pendingRolls[
                    room.rollPermissionIndex
                ].extraAvailable = false;
            }

            room.rollPermissionIndex = -1;

            const value =
                DICE_VALUES[
                    Math.floor(
                        Math.random() *
                        DICE_VALUES.length
                    )
                ];

            player.lastRoll =
                value;

            const die = {

                id:
                    `${Date.now()}_${Math.random()}`,

                value,

                extraAvailable:
                    value === 4 ||
                    value === 8
            };

            room.pendingRolls.push(die);

            if (
                value === 4 ||
                value === 8
            ) {

                room.canRoll = true;

                room.rollPermissionIndex =
                    room.pendingRolls.length - 1;

            } else {

                room.canRoll = false;

                room.rollPermissionIndex =
                    -1;
            }

            io.to(room.id).emit(
                "diceRolled",
                {
                    playerId:
                        player.id,

                    value,

                    rollId:
                        die.id,

                    extraAvailable:
                        die.extraAvailable
                }
            );

            /* =================================================
               NO VALID MOVE
            ================================================= */

            if (
                !hasValidMove(
                    player,
                    value
                )
            ) {

                room.pendingRolls.pop();

                if (die.extraAvailable) {

                    room.canRoll = true;

                    room.rollPermissionIndex =
                        -1;

                    sendMessage(
                        room,
                        `${player.name} rolled ${value}. No valid move — roll again!`
                    );

                    sendState(room);

                    return;
                }

                if (room.pendingRolls.length) {

                    room.canRoll = false;

                    sendState(room);

                    return;
                }

                room.canRoll = false;

                room.active =
                    nextActive(room);

                room.canRoll = true;

                room.rollPermissionIndex =
                    -1;

                sendMessage(
                    room,
                    `${player.name} had no valid move.`
                );

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
                `${player.name} rolled ${value}.`
            );

            sendState(room);
        }
    );

    /* =====================================================
       MOVE
    ===================================================== */

    socket.on(
        "requestMove",
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
                Number(data?.playerId);

            const pawnIndex =
                Number(data?.pawnIndex);

            const player =
                getCurrentPlayer(room);

            if (
                !player ||
                Number(socket.data.playerId) !==
                    playerId ||
                player.id !== playerId
            ) {

                socket.emit(
                    "actionError",
                    "You cannot control this player."
                );

                return;
            }

            const rollId =
                String(
                    data?.rollId || ""
                );

            let rollIndex =
                room.pendingRolls.findIndex(
                    die =>
                        String(die.id) ===
                        rollId
                );

            if (
                rollIndex < 0 &&
                room.pendingRolls.length === 1
            ) {
                rollIndex = 0;
            }

            if (rollIndex < 0) {

                socket.emit(
                    "actionError",
                    "Choose a dice number first."
                );

                return;
            }

            const die =
                room.pendingRolls[
                    rollIndex
                ];

            const roll =
                die.value;

            if (
                !isValidMove(
                    player,
                    pawnIndex,
                    roll
                )
            ) {

                socket.emit(
                    "actionError",
                    "That pawn cannot move that far."
                );

                return;
            }

            const from =
                player.pawns[pawnIndex];

            const to =
                from + roll;

            room.pendingRolls.splice(
                rollIndex,
                1
            );

            room.canRoll = false;

            room.rollPermissionIndex = -1;

            player.pawns[pawnIndex] =
                to;

            /* =================================================
               CAPTURE EXACTLY ONE
            ================================================= */

            const captured =
                performCapture(
                    room,
                    player,
                    to
                );

            const captureHappened =
                captured.length > 0;

            if (captureHappened) {
                player.hasKilled = true;
            }

            const reachedHome =
                to === 24;

            /* =================================================
               WIN
            ================================================= */

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

            let extraTurn =
                !!die.extraAvailable;

            if (captureHappened) {
                extraTurn = true;
            }

            if (
                reachedHome &&
                !player.hasWon
            ) {
                extraTurn = true;
            }

            if (player.hasWon) {
                extraTurn = false;
            }

            if (player.hasWon) {

                checkGameFinished(room);

                extraTurn = false;
            }

            /* =================================================
               NEXT ACTION
            ================================================= */

            if (!room.finished) {

                if (extraTurn) {

                    room.canRoll = true;

                    room.rollPermissionIndex =
                        -1;

                    if (captureHappened) {

                        sendMessage(
                            room,
                            `${player.name} captured a pawn — roll again!`
                        );

                    } else if (
                        reachedHome &&
                        !player.hasWon
                    ) {

                        sendMessage(
                            room,
                            `${player.name} reached HOME — roll again!`
                        );

                    } else {

                        sendMessage(
                            room,
                            `${player.name} used ${roll} — roll again!`
                        );
                    }

                } else if (
                    room.pendingRolls.length > 0
                ) {

                    room.canRoll = false;

                    sendMessage(
                        room,
                        `${player.name} has another dice available.`
                    );

                } else {

                    room.active =
                        nextActive(room);

                    room.canRoll = true;

                    room.rollPermissionIndex =
                        -1;

                    const next =
                        getCurrentPlayer(room);

                    if (next) {

                        sendMessage(
                            room,
                            `${next.name}'s turn.`
                        );
                    }
                }
            }

            io.to(room.id).emit(
                "moveResult",
                {
                    playerId,
                    pawnIndex,

                    from,
                    to,

                    roll,

                    rollId:
                        die.id,

                    /*
                       This array now contains
                       at most ONE captured pawn.
                    */

                    captured,

                    extraTurn,

                    finished:
                        room.finished
                }
            );

            sendState(room);

            if (room.finished) {

                io.to(room.id).emit(
                    "gameFinished"
                );
            }
        }
    );

    /* =====================================================
       TEXT CHAT
    ===================================================== */

    socket.on(
        "sendChatMessage",
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
                    data?.text || ""
                )
                .trim()
                .slice(0,300);

            if (!text) {
                return;
            }

            /*
               ONLY real chat messages are sent
               through receiveChatMessage.
            */

            io.to(room.id).emit(
                "receiveChatMessage",
                {
                    name:
                        player.name,

                    text
                }
            );
        }
    );

    /* =====================================================
       VOICE CHAT
    ===================================================== */

    socket.on(
        "voiceJoin",
        () => {

            const room =
                getRoom(socket);

            if (!room) {
                return;
            }

            const peers =
                room.sockets
                    .filter(
                        s => s !== socket
                    )
                    .map(
                        s => s.id
                    );

            socket.emit(
                "voicePeers",
                peers
            );
        }
    );

    /*
       WebRTC signaling.

       We deliberately keep signaling on Socket.IO.
       Audio itself does NOT travel through the server.
    */

    socket.on(
        "voiceSignal",
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

            if (!target) {
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

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
        "disconnect",
        () => {

            console.log(
                "Disconnected:",
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

            closeRoom(
                room.id,
                "A player disconnected. The match has ended."
            );
        }
    );
});

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
