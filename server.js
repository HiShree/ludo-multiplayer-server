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

const PLAYER_IDS = [0, 1, 2, 3];

const PATHS = {
    0: [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],
    1: [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],
    2: [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],
    3: [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
};

const SAFE_CELLS = [2, 10, 14, 22, 12];

function randomRoll() {
    const values = [1, 1, 2, 2, 3, 3, 4, 8];
    return values[Math.floor(Math.random() * values.length)];
}

function isExtraRoll(value) {
    return value === 4 || value === 8;
}

function createPlayer(id) {
    return {
        id,
        pawns: [0, 0, 0, 0],
        hasKilled: false,
        hasWon: false,
        winRank: 0
    };
}

function canPawnMove(player, pawnIndex, roll) {
    const step = player.pawns[pawnIndex];

    if (step >= 24) {
        return false;
    }

    /*
       Before a player has made a capture,
       pawns can travel up to step 15.

       After a capture, they can travel to HOME at 24.
    */
    const maximum = player.hasKilled ? 24 : 15;

    return step + roll <= maximum;
}

function hasAnyMove(player, roll) {
    return player.pawns.some((_, index) =>
        canPawnMove(player, index, roll)
    );
}

function getRoomState(room) {
    return {
        players: room.players.map(p => ({
            id: p.id,
            pawns: [...p.pawns],
            hasKilled: p.hasKilled,
            hasWon: p.hasWon,
            winRank: p.winRank
        })),

        activeIndex: room.activeIndex,
        activePlayerId:
            room.players[room.activeIndex]
                ? room.players[room.activeIndex].id
                : null,

        activeRolls: [...room.activeRolls],
        canRoll: room.canRoll,
        currentRank: room.currentRank,
        gameOver: room.gameOver
    };
}

function broadcastState(room) {
    io.to(room.id).emit("gameState", getRoomState(room));
}

function advanceTurn(room) {
    if (room.gameOver) return;

    room.activeRolls = [];
    room.canRoll = true;

    let attempts = 0;

    do {
        room.activeIndex =
            (room.activeIndex + 1) % room.players.length;

        attempts++;

        if (attempts > room.players.length) {
            room.gameOver = true;
            break;
        }

    } while (room.players[room.activeIndex].hasWon);

    const remainingPlayers = room.players.filter(
        p => !p.hasWon
    );

    if (remainingPlayers.length <= 1) {
        room.gameOver = true;
    }
}

function finishBlockedRoll(room) {

    while (room.activeRolls.length > 0) {

        const player = room.players[room.activeIndex];
        const roll = room.activeRolls[0];

        if (hasAnyMove(player, roll)) {
            break;
        }

        room.activeRolls.shift();

        io.to(room.id).emit(
            "systemMessage",
            `${playerName(player.id)} rolled ${roll}, but has no possible move.`
        );
    }

    if (room.activeRolls.length === 0) {

        if (room.canRoll) {
            return;
        }

        advanceTurn(room);
        return;
    }

    const latestRoll =
        room.activeRolls[room.activeRolls.length - 1];

    room.canRoll = isExtraRoll(latestRoll);
}

function playerName(id) {
    return ["Blue", "Red", "Green", "Yellow"][id] || "Player";
}

function setupRoom(roomId, socketsArray) {

    const assignedIds =
        PLAYER_IDS.slice(0, socketsArray.length);

    const room = {
        id: roomId,
        sockets: [],
        players: [],
        activeIndex: 0,
        activeRolls: [],
        canRoll: true,
        currentRank: 1,
        gameOver: false,
        started: true,
        isPrivate: false
    };

    socketsArray.forEach((socket, index) => {

        const playerId = assignedIds[index];

        socket.join(roomId);

        socket.roomId = roomId;
        socket.playerIndex = playerId;

        room.sockets.push(socket.id);
        room.players.push(createPlayer(playerId));

        socket.emit("assignPlayer", playerId);
    });

    rooms[roomId] = room;

    io.to(roomId).emit(
        "gameStart",
        assignedIds
    );

    io.to(roomId).emit(
        "systemMessage",
        "Match started! Blue goes first."
    );

    broadcastState(room);
}

io.on("connection", socket => {

    console.log("Connected:", socket.id);

    // -----------------------------
    // PUBLIC MATCHMAKING
    // -----------------------------

    socket.on("joinGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit("roomError", "Invalid player count.");
            return;
        }

        leaveAllQueues(socket.id);

        publicQueues[numPlayers].push(socket);

        const queue =
            publicQueues[numPlayers];

        if (queue.length >= numPlayers) {

            const matched =
                queue.splice(0, numPlayers);

            const roomId =
                "pub_" +
                Math.random()
                    .toString(36)
                    .substring(2, 8);

            setupRoom(roomId, matched);

        } else {

            socket.emit(
                "systemMessage",
                `Waiting for ${
                    numPlayers - queue.length
                } more player(s)...`
            );
        }
    });

    // -----------------------------
    // PRIVATE ROOM CREATE
    // -----------------------------

    socket.on("createPrivateGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit(
                "roomError",
                "Invalid player count."
            );
            return;
        }

        leaveAllQueues(socket.id);

        const roomCode =
            Math.random()
                .toString(36)
                .substring(2, 8)
                .toUpperCase();

        rooms[roomCode] = {
            id: roomCode,
            sockets: [socket.id],
            players: [],
            maxPlayers: numPlayers,
            activeIndex: 0,
            activeRolls: [],
            canRoll: true,
            currentRank: 1,
            gameOver: false,
            started: false,
            isPrivate: true
        };

        socket.roomId = roomCode;

        socket.join(roomCode);

        socket.emit(
            "privateRoomCreated",
            roomCode
        );

        socket.emit(
            "systemMessage",
            `Room created. Share code: ${roomCode}`
        );
    });

    // -----------------------------
    // PRIVATE ROOM JOIN
    // -----------------------------

    socket.on("joinPrivateGame", code => {

        code = String(code)
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

        leaveAllQueues(socket.id);

        room.sockets.push(socket.id);

        socket.roomId = code;

        socket.join(code);

        io.to(code).emit(
            "systemMessage",
            `Player joined (${room.sockets.length}/${room.maxPlayers})...`
        );

        if (
            room.sockets.length ===
            room.maxPlayers
        ) {

            const socketsArray =
                room.sockets
                    .map(id => io.sockets.sockets.get(id))
                    .filter(Boolean);

            setupRoom(code, socketsArray);
        }
    });

    // -----------------------------
    // AUTHORITATIVE DICE ROLL
    // -----------------------------

    socket.on("requestRoll", () => {

        const room = rooms[socket.roomId];

        if (!room || !room.started || room.gameOver) {
            return;
        }

        const player =
            room.players[room.activeIndex];

        if (!player) return;

        if (player.id !== socket.playerIndex) {
            socket.emit(
                "actionRejected",
                "It is not your turn."
            );
            return;
        }

        if (!room.canRoll) {
            socket.emit(
                "actionRejected",
                "You must move a pawn first."
            );
            return;
        }

        const roll = randomRoll();

        room.activeRolls.push(roll);

        room.canRoll = isExtraRoll(roll);

        io.to(room.id).emit(
            "diceRolled",
            {
                playerId: player.id,
                value: roll
            }
        );

        finishBlockedRoll(room);

        broadcastState(room);
    });

    // -----------------------------
    // AUTHORITATIVE PAWN MOVE
    // -----------------------------

    socket.on("requestMove", data => {

        const room = rooms[socket.roomId];

        if (!room || !room.started || room.gameOver) {
            return;
        }

        const player =
            room.players[room.activeIndex];

        if (!player) return;

        if (player.id !== socket.playerIndex) {
            socket.emit(
                "actionRejected",
                "It is not your turn."
            );
            return;
        }

        const pawnIndex =
            Number(data && data.pawnIndex);

        if (
            !Number.isInteger(pawnIndex) ||
            pawnIndex < 0 ||
            pawnIndex > 3
        ) {
            return;
        }

        if (room.activeRolls.length === 0) {
            socket.emit(
                "actionRejected",
                "No roll available."
            );
            return;
        }

        const roll = room.activeRolls[0];

        if (!canPawnMove(player, pawnIndex, roll)) {

            socket.emit(
                "actionRejected",
                "That pawn cannot move that far."
            );

            return;
        }

        const consumedExtra =
            isExtraRoll(roll);

        room.activeRolls.shift();

        // Move pawn
        player.pawns[pawnIndex] += roll;

        const finalStep =
            player.pawns[pawnIndex];

        const finalCell =
            PATHS[player.id][finalStep];

        let earnedExtraTurn = consumedExtra;

        // -----------------------------
        // PAWN REACHED HOME
        // -----------------------------

        if (finalStep === 24) {

            if (
                player.pawns.every(
                    p => p === 24
                )
            ) {

                player.hasWon = true;
                player.winRank =
                    room.currentRank++;

                io.to(room.id).emit(
                    "playerFinished",
                    {
                        playerId: player.id,
                        rank: player.winRank
                    }
                );

                const remaining =
                    room.players.filter(
                        p => !p.hasWon
                    );

                if (remaining.length <= 1) {
                    room.gameOver = true;

                    broadcastState(room);

                    io.to(room.id).emit(
                        "gameOver",
                        {
                            winner:
                                remaining[0]
                                    ? remaining[0].id
                                    : player.id
                        }
                    );

                    return;
                }

                advanceTurn(room);
                broadcastState(room);
                return;

            } else {

                earnedExtraTurn = true;

                io.to(room.id).emit(
                    "systemMessage",
                    `${playerName(player.id)} sent a pawn HOME! Extra turn.`
                );
            }
        }

        // -----------------------------
        // CAPTURE
        // -----------------------------

        let captured = false;

        if (
            !SAFE_CELLS.includes(finalCell) &&
            finalStep < 24
        ) {

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
                            PATHS[opponent.id][opponentStep] ===
                                finalCell
                        ) {

                            opponent.pawns[index] = 0;

                            captured = true;
                        }
                    }
                );
            });
        }

        if (captured) {

            player.hasKilled = true;
            earnedExtraTurn = true;

            io.to(room.id).emit(
                "systemMessage",
                `${playerName(player.id)} captured a pawn! Extra turn.`
            );
        }

        // -----------------------------
        // DECIDE NEXT ACTION
        // -----------------------------

        if (room.activeRolls.length > 0) {

            const latest =
                room.activeRolls[
                    room.activeRolls.length - 1
                ];

            room.canRoll =
                isExtraRoll(latest);

        } else {

            room.canRoll =
                earnedExtraTurn;

            if (!earnedExtraTurn) {
                advanceTurn(room);
            }
        }

        broadcastState(room);
    });

    // -----------------------------
    // CHAT
    // -----------------------------

    socket.on("sendChatMessage", data => {

        const room = rooms[socket.roomId];

        if (!room) return;

        const name =
            playerName(socket.playerIndex);

        const text =
            String(data?.text || "")
                .trim()
                .substring(0, 300);

        if (!text) return;

        io.to(room.id).emit(
            "receiveChatMessage",
            {
                name,
                text
            }
        );
    });

    // -----------------------------
    // WEBRTC VOICE SIGNALING
    // -----------------------------

    socket.on("getVoicePeers", () => {

        const room = rooms[socket.roomId];

        if (!room) return;

        const peers =
            room.sockets
                .filter(id => id !== socket.id);

        socket.emit(
            "voicePeers",
            peers
        );
    });

    socket.on("voiceOffer", data => {

        const target =
            io.sockets.sockets.get(data.target);

        if (!target) return;

        target.emit(
            "voiceOffer",
            {
                from: socket.id,
                offer: data.offer
            }
        );
    });

    socket.on("voiceAnswer", data => {

        const target =
            io.sockets.sockets.get(data.target);

        if (!target) return;

        target.emit(
            "voiceAnswer",
            {
                from: socket.id,
                answer: data.answer
            }
        );
    });

    socket.on("voiceCandidate", data => {

        const target =
            io.sockets.sockets.get(data.target);

        if (!target) return;

        target.emit(
            "voiceCandidate",
            {
                from: socket.id,
                candidate: data.candidate
            }
        );
    });

    // -----------------------------
    // DISCONNECT
    // -----------------------------

    socket.on("disconnect", () => {

        console.log(
            "Disconnected:",
            socket.id
        );

        leaveAllQueues(socket.id);

        const roomId =
            socket.roomId;

        if (!roomId) return;

        const room =
            rooms[roomId];

        if (!room) return;

        io.to(roomId).emit(
            "playerDisconnected",
            {
                playerId:
                    socket.playerIndex
            }
        );

        delete rooms[roomId];
    });
});

function leaveAllQueues(socketId) {

    Object.keys(publicQueues).forEach(
        key => {

            publicQueues[key] =
                publicQueues[key]
                    .filter(
                        socket =>
                            socket.id !== socketId
                    );
        }
    );
}

server.listen(PORT, () => {

    console.log(
        `Ludo Twist server running on port ${PORT}`
    );
});
