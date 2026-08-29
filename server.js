const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = {};

const PLAYER_IDS = [0, 1, 2, 3];

const COLORS = [
    { name: "Blue", color: "#1e90ff" },
    { name: "Red", color: "#ff4757" },
    { name: "Green", color: "#2ed573" },
    { name: "Yellow", color: "#ffa502" }
];

const PATHS = [
    [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],
    [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],
    [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],
    [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
];

const SAFE_CELLS = new Set([2, 10, 14, 22, 12]);

function makePlayer(id) {
    return {
        id,
        name: COLORS[id].name,
        color: COLORS[id].color,
        pawns: [0, 0, 0, 0],
        hasKilled: false,
        hasWon: false,
        winRank: 0
    };
}

function createGameState(playerIds) {
    return {
        playerIds,
        players: playerIds.map(makePlayer),
        activeIndex: 0,
        roll: null,
        canRoll: true,
        moving: false,
        rank: 1,
        gameOver: false
    };
}

function getRoomOfSocket(socket) {
    for (const room of socket.rooms) {
        if (room !== socket.id) return room;
    }
    return null;
}

function removeFromQueues(socketId) {
    for (const key of Object.keys(publicQueues)) {
        publicQueues[key] = publicQueues[key].filter(s => s.id !== socketId);
    }
}

function sendState(roomId) {
    const room = rooms[roomId];
    if (!room || !room.game) return;

    io.to(roomId).emit("gameState", room.game);
}

function setupRoom(roomId, sockets) {
    const playerIds = PLAYER_IDS.slice(0, sockets.length);

    const room = rooms[roomId] || {
        private: false,
        maxPlayers: sockets.length,
        sockets: [],
        started: false
    };

    room.sockets = sockets;
    room.maxPlayers = sockets.length;
    room.started = true;
    room.game = createGameState(playerIds);

    rooms[roomId] = room;

    sockets.forEach((sock, index) => {
        sock.roomId = roomId;
        sock.playerIndex = playerIds[index];

        sock.join(roomId);

        sock.emit("assignPlayer", playerIds[index]);
    });

    io.to(roomId).emit("gameStart", playerIds);

    io.to(roomId).emit(
        "systemMessage",
        "Match started! Blue goes first."
    );

    sendState(roomId);
}

function nextPlayer(roomId) {
    const room = rooms[roomId];
    if (!room || !room.game) return;

    const game = room.game;

    game.roll = null;
    game.canRoll = true;
    game.moving = false;

    let attempts = 0;

    do {
        game.activeIndex =
            (game.activeIndex + 1) % game.players.length;

        attempts++;

        if (attempts > game.players.length) {
            game.gameOver = true;
            break;
        }
    } while (game.players[game.activeIndex].hasWon);

    sendState(roomId);
}

function hasValidMove(player, roll) {
    if (!player || !roll) return false;

    return player.pawns.some(step => step + roll <= 24);
}

function performMove(roomId, playerId, pawnIndex) {
    const room = rooms[roomId];

    if (!room || !room.game) return;

    const game = room.game;

    if (game.gameOver || game.moving) return;

    const player = game.players[game.activeIndex];

    if (!player) return;

    if (player.id !== playerId) return;

    if (!Number.isInteger(pawnIndex) || pawnIndex < 0 || pawnIndex > 3) {
        return;
    }

    if (!game.roll) return;

    const roll = game.roll;

    if (player.pawns[pawnIndex] + roll > 24) {
        return;
    }

    game.moving = true;
    sendState(roomId);

    let step = player.pawns[pawnIndex];

    function moveOneStep() {
        if (!rooms[roomId] || !rooms[roomId].game) return;

        if (step < player.pawns[pawnIndex] + roll) {
            step++;

            player.pawns[pawnIndex] = step;

            io.to(roomId).emit("pawnStep", {
                playerId,
                pawnIndex,
                step
            });

            sendState(roomId);

            setTimeout(moveOneStep, 180);
            return;
        }

        finishMove(roomId, playerId, pawnIndex);
    }

    moveOneStep();
}

function finishMove(roomId, playerId, pawnIndex) {
    const room = rooms[roomId];

    if (!room || !room.game) return;

    const game = room.game;
    const player = game.players[game.activeIndex];

    if (!player || player.id !== playerId) return;

    const finalStep = player.pawns[pawnIndex];
    const finalCell = PATHS[player.id][finalStep];

    let extraTurn = false;

    // Reached HOME
    if (finalStep === 24) {
        extraTurn = true;
    }

    // Capture opponent
    if (!SAFE_CELLS.has(finalCell) && finalStep < 24) {
        for (const opponent of game.players) {
            if (opponent.id === player.id || opponent.hasWon) continue;

            opponent.pawns.forEach((oppStep, oppIndex) => {
                if (
                    oppStep < 24 &&
                    PATHS[opponent.id][oppStep] === finalCell
                ) {
                    opponent.pawns[oppIndex] = 0;
                    player.hasKilled = true;
                    extraTurn = true;

                    io.to(roomId).emit("pawnCaptured", {
                        attackerId: player.id,
                        attackerPawn: pawnIndex,
                        victimId: opponent.id,
                        victimPawn: oppIndex
                    });
                }
            });
        }
    }

    // Player finished all pawns
    if (player.pawns.every(p => p === 24)) {
        player.hasWon = true;
        player.winRank = game.rank++;
    }

    game.roll = null;
    game.moving = false;

    // 4 / 8, capture or home = extra turn
    if (
        extraTurn &&
        !player.hasWon
    ) {
        game.canRoll = true;

        io.to(roomId).emit(
            "systemMessage",
            `${player.name} gets an extra turn!`
        );

        sendState(roomId);
        return;
    }

    // If player won and others remain, continue
    if (player.hasWon) {
        const remaining = game.players.filter(p => !p.hasWon);

        if (remaining.length <= 1) {
            game.gameOver = true;
            game.canRoll = false;

            io.to(roomId).emit(
                "systemMessage",
                `${player.name} wins the game!`
            );

            sendState(roomId);
            return;
        }
    }

    nextPlayer(roomId);
}

io.on("connection", socket => {

    console.log("Connected:", socket.id);

    socket.on("joinGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit("roomError", "Invalid player count.");
            return;
        }

        removeFromQueues(socket.id);

        publicQueues[numPlayers].push(socket);

        socket.emit(
            "systemMessage",
            `Waiting for ${numPlayers - publicQueues[numPlayers].length} more player(s)...`
        );

        if (publicQueues[numPlayers].length >= numPlayers) {

            const players =
                publicQueues[numPlayers].splice(0, numPlayers);

            const roomId =
                "pub_" +
                Math.random().toString(36).substring(2, 8);

            setupRoom(roomId, players);
        }
    });

    socket.on("createPrivateGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit("roomError", "Invalid player count.");
            return;
        }

        removeFromQueues(socket.id);

        const code =
            Math.random()
                .toString(36)
                .substring(2, 8)
                .toUpperCase();

        rooms[code] = {
            private: true,
            maxPlayers: numPlayers,
            sockets: [socket],
            started: false,
            game: null
        };

        socket.roomId = code;
        socket.playerIndex = 0;

        socket.join(code);

        socket.emit("privateRoomCreated", code);

        socket.emit(
            "systemMessage",
            `Room created. Code: ${code}`
        );
    });

    socket.on("joinPrivateGame", code => {

        code = String(code || "").trim().toUpperCase();

        const room = rooms[code];

        if (!room) {
            socket.emit(
                "roomError",
                "Room code not found."
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

        if (room.sockets.length >= room.maxPlayers) {
            socket.emit(
                "roomError",
                "Room is full."
            );
            return;
        }

        removeFromQueues(socket.id);

        room.sockets.push(socket);

        socket.roomId = code;
        socket.playerIndex = room.sockets.length - 1;

        socket.join(code);

        io.to(code).emit(
            "systemMessage",
            `Players joined: ${room.sockets.length}/${room.maxPlayers}`
        );

        if (room.sockets.length === room.maxPlayers) {
            setupRoom(code, room.sockets);
        }
    });

    // SERVER AUTHORITATIVE ROLL
    socket.on("requestRoll", () => {

        const roomId = socket.roomId;
        const room = rooms[roomId];

        if (!room || !room.game) return;

        const game = room.game;
        const player = game.players[game.activeIndex];

        if (!player) return;

        // Only current player may roll
        if (player.id !== socket.playerIndex) return;

        // Prevent double rolling
        if (!game.canRoll || game.moving || game.gameOver) return;

        const roll =
            [1, 1, 2, 2, 3, 3, 4, 8]
            [Math.floor(Math.random() * 8)];

        game.roll = roll;
        game.canRoll = false;

        io.to(roomId).emit("diceRolled", {
            playerId: player.id,
            value: roll
        });

        if (!hasValidMove(player, roll)) {

            io.to(roomId).emit(
                "systemMessage",
                `${player.name} rolled ${roll}, but has no valid move.`
            );

            // 4 or 8 gets another roll
            if (roll === 4 || roll === 8) {
                game.roll = null;
                game.canRoll = true;

                sendState(roomId);
            } else {
                setTimeout(() => {
                    nextPlayer(roomId);
                }, 900);
            }

            return;
        }

        // 4 / 8 allows another roll AFTER movement
        sendState(roomId);
    });

    socket.on("requestMove", data => {

        const roomId = socket.roomId;

        if (!roomId) return;

        if (socket.playerIndex !== Number(data.playerId)) {
            return;
        }

        performMove(
            roomId,
            Number(data.playerId),
            Number(data.pawnIndex)
        );
    });

    // CHAT
    socket.on("sendChatMessage", data => {

        const roomId = socket.roomId;

        if (!roomId) return;

        const player =
            COLORS[socket.playerIndex] || COLORS[0];

        const text =
            String(data?.text || "")
                .trim()
                .substring(0, 250);

        if (!text) return;

        io.to(roomId).emit("receiveChatMessage", {
            name: player.name,
            text
        });
    });

    // WEBRTC SIGNALING
    socket.on("voiceOffer", data => {
        const roomId = socket.roomId;

        if (!roomId) return;

        socket.to(roomId).emit("voiceOffer", {
            from: socket.id,
            offer: data.offer
        });
    });

    socket.on("voiceAnswer", data => {
        const roomId = socket.roomId;

        if (!roomId) return;

        io.to(data.to).emit("voiceAnswer", {
            from: socket.id,
            answer: data.answer
        });
    });

    socket.on("voiceCandidate", data => {
        const roomId = socket.roomId;

        if (!roomId) return;

        io.to(data.to).emit("voiceCandidate", {
            from: socket.id,
            candidate: data.candidate
        });
    });

    socket.on("voiceStop", () => {
        const roomId = socket.roomId;

        if (!roomId) return;

        socket.to(roomId).emit("voiceStop", {
            from: socket.id
        });
    });

    socket.on("disconnect", () => {

        removeFromQueues(socket.id);

        const roomId = socket.roomId;

        if (roomId && rooms[roomId]) {

            const room = rooms[roomId];

            room.sockets =
                room.sockets.filter(s => s.id !== socket.id);

            io.to(roomId).emit(
                "systemMessage",
                "A player disconnected."
            );

            // Don't allow stale rooms to break future matches
            if (room.sockets.length === 0) {
                delete rooms[roomId];
            }
        }

        console.log("Disconnected:", socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
