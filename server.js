const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = {};

const allPlayers = [
    {
        id: 0,
        name: "Blue",
        color: "#1e90ff",
        path: [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12]
    },
    {
        id: 1,
        name: "Red",
        color: "#ff4757",
        path: [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12]
    },
    {
        id: 2,
        name: "Green",
        color: "#2ed573",
        path: [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12]
    },
    {
        id: 3,
        name: "Yellow",
        color: "#ffa502",
        path: [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
    }
];

function makePlayer(id) {
    return {
        id,
        name: allPlayers[id].name,
        color: allPlayers[id].color,
        pawns: [0, 0, 0, 0],
        hasKilled: false,
        hasWon: false,
        winRank: 0
    };
}

function makeRoom(id, maxPlayers, isPrivate) {
    return {
        id,
        maxPlayers,
        isPrivate,
        started: false,
        sockets: [],
        players: [],
        activeIndex: 0,
        activeRolls: [],
        canRoll: true,
        currentRank: 1
    };
}

function getRoom(socket) {
    if (!socket.gameRoom) return null;
    return rooms[socket.gameRoom] || null;
}

function sendState(room) {
    if (!room) return;

    io.to(room.id).emit("gameState", {
        activeIndex: room.activeIndex,
        activeRolls: [...room.activeRolls],
        canRoll: room.canRoll,
        currentRank: room.currentRank,

        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            pawns: [...p.pawns],
            hasKilled: p.hasKilled,
            hasWon: p.hasWon,
            winRank: p.winRank
        }))
    });
}

function status(room, text) {
    if (!room) return;

    io.to(room.id).emit("statusMessage", text);
}

function removeFromQueues(socketId) {
    for (const key of Object.keys(publicQueues)) {
        publicQueues[key] = publicQueues[key].filter(
            s => s && s.id !== socketId
        );
    }
}

function generateRoomCode() {
    let code;

    do {
        code = Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase();
    } while (rooms[code]);

    return code;
}

function currentPlayer(room) {
    return room.players[room.activeIndex];
}

function validPlayer(room, socket, playerId) {
    return (
        room &&
        socket.gameRoom === room.id &&
        socket.playerIndex === playerId &&
        room.players.some(p => p.id === playerId)
    );
}

function hasValidMove(player, roll) {
    const maxStep = player.hasKilled ? 24 : 15;

    return player.pawns.some(
        step => step + roll <= maxStep
    );
}

function nextActiveIndex(room) {
    if (!room.players.length) return 0;

    let next = room.activeIndex;

    for (let i = 0; i < room.players.length; i++) {
        next = (next + 1) % room.players.length;

        if (!room.players[next].hasWon) {
            return next;
        }
    }

    return room.activeIndex;
}

function advanceTurn(room) {
    room.activeRolls = [];
    room.canRoll = true;
    room.activeIndex = nextActiveIndex(room);

    const player = currentPlayer(room);

    if (player) {
        status(room, `${player.name}'s turn.`);
    }

    sendState(room);
}

function setupRoom(room) {
    const sockets = room.sockets;

    room.players = [];

    sockets.forEach((socket, index) => {
        const playerId = index;

        socket.playerIndex = playerId;
        socket.gameRoom = room.id;

        socket.join(room.id);

        room.players.push(makePlayer(playerId));

        socket.emit("assignPlayer", {
            playerId,
            playerName: allPlayers[playerId].name
        });
    });

    room.started = true;
    room.activeIndex = 0;
    room.activeRolls = [];
    room.canRoll = true;
    room.currentRank = 1;

    io.to(room.id).emit("gameStart", {
        players: room.players.map(p => p.id)
    });

    status(room, "Match started! Blue goes first.");

    sendState(room);
}

function closeRoom(room, message) {
    if (!room) return;

    io.to(room.id).emit(
        "roomClosed",
        message || "Room closed."
    );

    room.sockets.forEach(socket => {
        socket.leave(room.id);
        socket.gameRoom = null;
        socket.playerIndex = null;
    });

    delete rooms[room.id];
}

io.on("connection", socket => {

    console.log("Connected:", socket.id);

    /*
    ========================================
    PUBLIC MATCHMAKING
    ========================================
    */

    socket.on("joinGame", count => {

        count = Number(count);

        if (![2, 3, 4].includes(count)) {
            socket.emit(
                "roomError",
                "Invalid player count."
            );
            return;
        }

        removeFromQueues(socket.id);

        socket.gameRoom = null;
        socket.playerIndex = null;

        publicQueues[count].push(socket);

        const queue = publicQueues[count];

        socket.emit(
            "statusMessage",
            `Waiting for ${count - queue.length} more player(s)...`
        );

        if (queue.length >= count) {

            const matched = queue.splice(0, count);

            const roomId =
                "pub_" +
                Math.random()
                    .toString(36)
                    .substring(2, 8);

            const room =
                makeRoom(roomId, count, false);

            rooms[roomId] = room;

            room.sockets = matched;

            setupRoom(room);
        }
    });

    /*
    ========================================
    PRIVATE ROOM CREATE
    ========================================
    */

    socket.on("createPrivateGame", count => {

        count = Number(count);

        if (![2, 3, 4].includes(count)) {
            socket.emit(
                "roomError",
                "Invalid player count."
            );
            return;
        }

        removeFromQueues(socket.id);

        const code = generateRoomCode();

        const room =
            makeRoom(code, count, true);

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
            `Room created. Share code: ${code}`
        );
    });

    /*
    ========================================
    PRIVATE ROOM JOIN
    ========================================
    */

    socket.on("joinPrivateGame", code => {

        code = String(code || "")
            .trim()
            .toUpperCase();

        const room = rooms[code];

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

        if (room.sockets.length >= room.maxPlayers) {
            socket.emit(
                "roomError",
                "Room is full!"
            );
            return;
        }

        removeFromQueues(socket.id);

        room.sockets.push(socket);

        socket.gameRoom = code;
        socket.playerIndex = null;

        socket.join(code);

        status(
            room,
            `Player joined (${room.sockets.length}/${room.maxPlayers}).`
        );

        if (room.sockets.length === room.maxPlayers) {
            setupRoom(room);
        }
    });

    /*
    ========================================
    ROLL DICE
    ========================================
    */

    socket.on("requestRoll", () => {

        const room = getRoom(socket);

        if (!room || !room.started) return;

        const player = currentPlayer(room);

        if (!player) return;

        if (socket.playerIndex !== player.id) {
            socket.emit(
                "actionError",
                "It is not your turn."
            );
            return;
        }

        if (!room.canRoll) {
            socket.emit(
                "actionError",
                "Move a pawn first."
            );
            return;
        }

        const values = [
            1, 1,
            2, 2,
            3, 3,
            4,
            8
        ];

        const roll =
            values[
                Math.floor(
                    Math.random() * values.length
                )
            ];

        room.canRoll = false;
        room.activeRolls.push(roll);

        io.to(room.id).emit(
            "diceRolled",
            {
                playerId: player.id,
                value: roll
            }
        );

        if (!hasValidMove(player, roll)) {

            room.activeRolls.shift();

            if (roll === 4 || roll === 8) {

                room.canRoll = true;

                status(
                    room,
                    `${player.name} rolled ${roll}. Extra roll!`
                );

                sendState(room);

            } else {

                status(
                    room,
                    `${player.name} rolled ${roll}. No valid move.`
                );

                advanceTurn(room);
            }

            return;
        }

        status(
            room,
            `${player.name} rolled ${roll}. Choose a pawn.`
        );

        sendState(room);
    });

    /*
    ========================================
    MOVE PAWN
    ========================================
    */

    socket.on("requestMove", data => {

        const room = getRoom(socket);

        if (!room || !room.started) return;

        const playerId =
            Number(data?.playerId);

        const pawnIndex =
            Number(data?.pawnIndex);

        if (
            !Number.isInteger(playerId) ||
            !Number.isInteger(pawnIndex)
        ) {
            return;
        }

        if (
            pawnIndex < 0 ||
            pawnIndex > 3
        ) {
            return;
        }

        if (!validPlayer(room, socket, playerId)) {

            socket.emit(
                "actionError",
                "You cannot control this player."
            );

            return;
        }

        const player = currentPlayer(room);

        if (!player || player.id !== playerId) {

            socket.emit(
                "actionError",
                "It is not your turn."
            );

            return;
        }

        if (room.activeRolls.length === 0) {

            socket.emit(
                "actionError",
                "Roll the dice first."
            );

            return;
        }

        const roll = room.activeRolls[0];

        const oldStep =
            player.pawns[pawnIndex];

        const maxStep =
            player.hasKilled ? 24 : 15;

        if (oldStep + roll > maxStep) {

            socket.emit(
                "actionError",
                "That pawn cannot move."
            );

            return;
        }

        room.activeRolls.shift();

        const newStep =
            oldStep + roll;

        player.pawns[pawnIndex] =
            newStep;

        let captured = [];
        let extraTurn = false;

        const targetCell =
            allPlayers[player.id].path[newStep];

        /*
        ========================================
        HOME
        ========================================
        */

        if (newStep === 24) {

            if (
                player.pawns.every(
                    p => p === 24
                )
            ) {

                player.hasWon = true;
                player.winRank =
                    room.currentRank++;

                status(
                    room,
                    `${player.name} finished #${player.winRank}!`
                );

            } else {

                extraTurn = true;

                status(
                    room,
                    `${player.name} reached HOME! Extra turn.`
                );
            }
        }

        /*
        ========================================
        CAPTURE
        ========================================
        */

        const safeCells =
            [2, 10, 14, 22, 12];

        if (!safeCells.includes(targetCell)) {

            room.players.forEach(opponent => {

                if (
                    opponent.id === player.id ||
                    opponent.hasWon
                ) {
                    return;
                }

                opponent.pawns.forEach(
                    (opponentStep, index) => {

                        if (
                            opponentStep < 24 &&
                            allPlayers[opponent.id]
                                .path[opponentStep] === targetCell
                        ) {

                            opponent.pawns[index] = 0;

                            captured.push({
                                playerId: opponent.id,
                                pawnIndex: index
                            });

                            player.hasKilled = true;

                            extraTurn = true;
                        }
                    }
                );
            });
        }

        /*
        ========================================
        TURN DECISION
        ========================================
        */

        if (player.hasWon) {

            const remaining =
                room.players.filter(
                    p => !p.hasWon
                );

            if (remaining.length <= 1) {

                sendState(room);

                io.to(room.id).emit(
                    "gameFinished"
                );

                return;
            }

            room.activeRolls = [];
            room.canRoll = true;
            room.activeIndex =
                nextActiveIndex(room);

        } else if (extraTurn) {

            room.canRoll = true;

        } else {

            room.canRoll = true;
            room.activeIndex =
                nextActiveIndex(room);
        }

        io.to(room.id).emit(
            "moveResult",
            {
                playerId,
                pawnIndex,
                from: oldStep,
                to: newStep,
                roll,
                captured
            }
        );

        sendState(room);
    });

    /*
    ========================================
    PLAYER CHAT
    ========================================
    */

    socket.on("sendChatMessage", data => {

        const room = getRoom(socket);

        if (!room) return;

        const player =
            room.players.find(
                p => p.id === socket.playerIndex
            );

        if (!player) return;

        const text =
            String(data?.text || "")
                .trim()
                .substring(0, 300);

        if (!text) return;

        /*
        IMPORTANT:
        Only this event goes into the chat.
        Server status messages do NOT use it.
        */

        io.to(room.id).emit(
            "receiveChatMessage",
            {
                playerId: player.id,
                name: player.name,
                text
            }
        );
    });

    /*
    ========================================
    WEBRTC VOICE
    ========================================
    */

    socket.on("voiceOffer", data => {

        const room = getRoom(socket);

        if (!room) return;

        socket.to(room.id).emit(
            "voiceOffer",
            {
                from: socket.playerIndex,
                offer: data.offer
            }
        );
    });

    socket.on("voiceAnswer", data => {

        const room = getRoom(socket);

        if (!room) return;

        socket.to(room.id).emit(
            "voiceAnswer",
            {
                from: socket.playerIndex,
                answer: data.answer
            }
        );
    });

    socket.on("iceCandidate", data => {

        const room = getRoom(socket);

        if (!room) return;

        socket.to(room.id).emit(
            "iceCandidate",
            {
                from: socket.playerIndex,
                candidate: data.candidate
            }
        );
    });

    /*
    ========================================
    DISCONNECT
    ========================================
    */

    socket.on("disconnect", () => {

        console.log(
            "Disconnected:",
            socket.id
        );

        removeFromQueues(socket.id);

        const room = getRoom(socket);

        if (!room) return;

        closeRoom(
            room,
            "A player disconnected. The match has ended."
        );
    });
});

server.listen(PORT, () => {
    console.log(
        `Ludo Twist server running on port ${PORT}`
    );
});
