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

const PLAYER_INFO = [
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

function createPlayer(id) {
    return {
        id,
        pawns: [0, 0, 0, 0],
        hasKilled: false,
        hasWon: false,
        winRank: 0
    };
}

function createGameState(playerIds) {
    return {
        players: playerIds.map(id => createPlayer(id)),
        activeIndex: 0,
        activeRolls: [],
        canRoll: true,
        rank: 1,
        processing: false,
        started: true
    };
}

function getRoomForSocket(socket) {
    return socket.gameRoom || null;
}

function removeFromQueues(socketId) {
    Object.keys(publicQueues).forEach(key => {
        publicQueues[key] = publicQueues[key].filter(
            s => s && s.id !== socketId
        );
    });
}

function sendState(roomId) {
    const room = rooms[roomId];

    if (!room || !room.game) return;

    const state = {
        activeIndex: room.game.activeIndex,
        activeRolls: [...room.game.activeRolls],
        canRoll: room.game.canRoll,
        rank: room.game.rank,
        processing: room.game.processing,

        players: room.game.players.map(p => ({
            id: p.id,
            pawns: [...p.pawns],
            hasKilled: p.hasKilled,
            hasWon: p.hasWon,
            winRank: p.winRank
        }))
    };

    io.to(roomId).emit("forceSync", state);
}

function sendStatus(roomId, message) {
    io.to(roomId).emit("systemMessage", message);
}

function getCurrentPlayer(room) {
    return room.game.players[room.game.activeIndex];
}

function getPlayer(room, playerId) {
    return room.game.players.find(p => p.id === playerId);
}

function getPlayerSocket(room, playerId) {
    return room.sockets.find(s => s.playerIndex === playerId);
}

function validRollValue(value) {
    return [1, 2, 3, 4, 8].includes(value);
}

function randomRoll() {
    const rolls = [1, 1, 2, 2, 3, 3, 4, 8];
    return rolls[Math.floor(Math.random() * rolls.length)];
}

function hasValidMove(player, roll) {
    return player.pawns.some(step => {
        const maximum = player.hasKilled ? 24 : 15;
        return step + roll <= maximum;
    });
}

function isSafeCell(cell) {
    return [2, 10, 14, 22, 12].includes(cell);
}

function advanceTurn(room) {
    room.game.activeRolls = [];
    room.game.canRoll = true;
    room.game.processing = false;

    let attempts = 0;

    do {
        room.game.activeIndex =
            (room.game.activeIndex + 1) %
            room.game.players.length;

        attempts++;

        if (attempts > room.game.players.length) {
            break;
        }

    } while (room.game.players[room.game.activeIndex].hasWon);

    const current = getCurrentPlayer(room);

    if (current) {
        sendStatus(
            room.id,
            `${PLAYER_INFO[current.id].name}'s turn.`
        );
    }

    sendState(room);
}

function finishMove(room, playerId, pawnIndex, roll) {

    const player = getPlayer(room, playerId);

    if (!player) return;

    const previousStep = player.pawns[pawnIndex];

    if (previousStep + roll > (player.hasKilled ? 24 : 15)) {
        room.game.processing = false;
        sendState(room);
        return;
    }

    player.pawns[pawnIndex] += roll;

    const finalStep = player.pawns[pawnIndex];
    const finalCell = PLAYER_INFO[player.id].path[finalStep];

    let extraTurn = false;

    // Reaching home
    if (finalStep === 24) {

        if (player.pawns.every(step => step === 24)) {

            player.hasWon = true;
            player.winRank = room.game.rank;
            room.game.rank++;

            sendStatus(
                room.id,
                `${PLAYER_INFO[player.id].name} finished!`
            );

            room.game.processing = false;

            const remaining = room.game.players.filter(
                p => !p.hasWon
            );

            if (remaining.length <= 1) {
                sendStatus(
                    room.id,
                    "Game finished!"
                );
                sendState(room);
                return;
            }

            setTimeout(() => {
                advanceTurn(room);
            }, 900);

            sendState(room);
            return;

        } else {
            extraTurn = true;
        }
    }

    // Capture
    let captured = false;

    if (!isSafeCell(finalCell)) {

        for (const opponent of room.game.players) {

            if (opponent.id === player.id || opponent.hasWon) {
                continue;
            }

            for (let i = 0; i < opponent.pawns.length; i++) {

                const opponentStep = opponent.pawns[i];

                if (opponentStep >= 24) continue;

                const opponentCell =
                    PLAYER_INFO[opponent.id].path[opponentStep];

                if (opponentCell === finalCell) {

                    opponent.pawns[i] = 0;

                    captured = true;
                    player.hasKilled = true;

                    extraTurn = true;
                }
            }
        }
    }

    room.game.processing = false;

    // Remove the roll that was used
    if (room.game.activeRolls.length > 0) {
        room.game.activeRolls.shift();
    }

    if (captured) {
        sendStatus(
            room.id,
            `${PLAYER_INFO[player.id].name} captured a pawn! Extra turn!`
        );
    } else if (extraTurn) {
        sendStatus(
            room.id,
            `${PLAYER_INFO[player.id].name} gets an extra turn!`
        );
    }

    if (room.game.activeRolls.length > 0) {

        room.game.canRoll = false;

        sendState(room);

        // Automatically skip impossible remaining rolls
        while (
            room.game.activeRolls.length > 0 &&
            !hasValidMove(
                player,
                room.game.activeRolls[0]
            )
        ) {
            const blocked = room.game.activeRolls.shift();

            sendStatus(
                room.id,
                `${blocked} is blocked.`
            );
        }

        if (room.game.activeRolls.length === 0) {
            setTimeout(() => {
                advanceTurn(room);
            }, 700);
        } else {
            sendState(room);
        }

        return;
    }

    // Extra turn
    if (extraTurn) {
        room.game.canRoll = true;
        sendState(room);

        sendStatus(
            room.id,
            `${PLAYER_INFO[player.id].name}: roll again!`
        );

        return;
    }

    // Normal turn ends
    setTimeout(() => {
        advanceTurn(room);
    }, 500);

    sendState(room);
}

function setupRoom(roomId, socketsArray) {

    const playerIds = PLAYER_IDS.slice(
        0,
        socketsArray.length
    );

    const room = {
        id: roomId,
        sockets: socketsArray,
        started: true,
        isPrivate: !!rooms[roomId]?.isPrivate,
        game: createGameState(playerIds)
    };

    rooms[roomId] = room;

    socketsArray.forEach((socket, index) => {

        const playerId = playerIds[index];

        socket.gameRoom = roomId;
        socket.playerIndex = playerId;

        socket.join(roomId);

        socket.emit(
            "assignPlayer",
            playerId
        );
    });

    io.to(roomId).emit(
        "gameStart",
        playerIds
    );

    sendStatus(
        roomId,
        "Match started! Blue goes first."
    );

    sendState(roomId);
}

io.on("connection", socket => {

    console.log(
        "User connected:",
        socket.id
    );

    socket.on("joinGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            return;
        }

        removeFromQueues(socket.id);

        publicQueues[numPlayers].push(socket);

        const queue = publicQueues[numPlayers];

        if (queue.length >= numPlayers) {

            const matched = queue.splice(
                0,
                numPlayers
            );

            const roomId =
                "pub_" +
                Math.random()
                    .toString(36)
                    .substring(2, 8);

            rooms[roomId] = {
                id: roomId,
                sockets: matched,
                started: false,
                isPrivate: false,
                game: null
            };

            matched.forEach(s => {
                s.join(roomId);
            });

            setupRoom(
                roomId,
                matched
            );

        } else {

            socket.emit(
                "systemMessage",
                `Waiting for ${
                    numPlayers - queue.length
                } more player(s)...`
            );
        }
    });

    socket.on("createPrivateGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            return;
        }

        removeFromQueues(socket.id);

        let code;

        do {
            code = Math.random()
                .toString(36)
                .substring(2, 8)
                .toUpperCase();
        } while (rooms[code]);

        rooms[code] = {
            id: code,
            sockets: [socket],
            maxPlayers: numPlayers,
            started: false,
            isPrivate: true,
            game: null
        };

        socket.gameRoom = code;
        socket.join(code);

        socket.emit(
            "assignPlayer",
            0
        );

        socket.playerIndex = 0;

        socket.emit(
            "privateRoomCreated",
            code
        );

        socket.emit(
            "systemMessage",
            `Room created. Code: ${code}`
        );
    });

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

        if (!room.isPrivate) {
            socket.emit(
                "roomError",
                "Invalid private room!"
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

        socket.join(code);

        const assignedId =
            room.sockets.length - 1;

        socket.playerIndex = assignedId;

        socket.emit(
            "assignPlayer",
            assignedId
        );

        io.to(code).emit(
            "systemMessage",
            `Player joined (${room.sockets.length}/${room.maxPlayers})`
        );

        if (
            room.sockets.length ===
            room.maxPlayers
        ) {
            setupRoom(
                code,
                room.sockets
            );
        }
    });

    // SERVER-CONTROLLED ROLL
    socket.on("requestRoll", () => {

        const roomId = getRoomForSocket(socket);

        if (!roomId) return;

        const room = rooms[roomId];

        if (!room || !room.game) return;

        const current =
            getCurrentPlayer(room);

        if (!current) return;

        // IMPORTANT:
        // Only the player whose turn it is can roll.
        if (socket.playerIndex !== current.id) {
            return;
        }

        if (!room.game.canRoll) {
            return;
        }

        if (room.game.processing) {
            return;
        }

        room.game.canRoll = false;

        const roll = randomRoll();

        room.game.activeRolls.push(roll);

        sendStatus(
            roomId,
            `${PLAYER_INFO[current.id].name} rolled ${roll}.`
        );

        // Extra roll only for 4 or 8
        if (roll === 4 || roll === 8) {
            room.game.canRoll = true;
        }

        // Tell every client the same roll
        io.to(roomId).emit(
            "executeRoll",
            {
                playerId: current.id,
                rollValue: roll
            }
        );

        sendState(room);

        // Check whether any move exists
        if (!hasValidMove(current, roll)) {

            room.game.activeRolls.shift();

            room.game.canRoll = false;

            sendStatus(
                roomId,
                `${roll} blocked. Turn over.`
            );

            setTimeout(() => {
                advanceTurn(room);
            }, 800);

            return;
        }

        sendState(room);
    });

    // SERVER-CONTROLLED MOVE
    socket.on("requestMove", data => {

        const roomId = getRoomForSocket(socket);

        if (!roomId) return;

        const room = rooms[roomId];

        if (!room || !room.game) return;

        const current =
            getCurrentPlayer(room);

        if (!current) return;

        if (socket.playerIndex !== current.id) {
            return;
        }

        if (room.game.processing) {
            return;
        }

        const pawnIndex =
            Number(data.pawnIndex);

        if (
            !Number.isInteger(pawnIndex) ||
            pawnIndex < 0 ||
            pawnIndex > 3
        ) {
            return;
        }

        if (
            room.game.activeRolls.length === 0
        ) {
            return;
        }

        const roll =
            room.game.activeRolls[0];

        const maximum =
            current.hasKilled ? 24 : 15;

        if (
            current.pawns[pawnIndex] + roll >
            maximum
        ) {
            return;
        }

        room.game.processing = true;
        room.game.canRoll = false;

        io.to(roomId).emit(
            "executeMove",
            {
                playerId: current.id,
                pawnIndex,
                rollValue: roll
            }
        );

        // Wait for clients to animate,
        // then update authoritative state.
        setTimeout(() => {

            if (!rooms[roomId]) return;

            finishMove(
                room,
                current.id,
                pawnIndex,
                roll
            );

        }, (roll * 140) + 100);
    });

    socket.on("sendChatMessage", data => {

        const roomId =
            getRoomForSocket(socket);

        if (!roomId) return;

        if (!data || typeof data.text !== "string") {
            return;
        }

        const text =
            data.text
                .trim()
                .substring(0, 250);

        if (!text) return;

        const player =
            PLAYER_INFO[socket.playerIndex];

        io.to(roomId).emit(
            "receiveChatMessage",
            {
                name: player
                    ? player.name
                    : "Player",
                text
            }
        );
    });

    socket.on("voiceData", audioData => {

        const roomId =
            getRoomForSocket(socket);

        if (!roomId) return;

        socket.to(roomId).emit(
            "voiceData",
            audioData
        );
    });

    socket.on("disconnect", () => {

        console.log(
            "User disconnected:",
            socket.id
        );

        removeFromQueues(socket.id);

        const roomId =
            socket.gameRoom;

        if (!roomId) return;

        const room = rooms[roomId];

        if (!room) return;

        room.sockets =
            room.sockets.filter(
                s => s.id !== socket.id
            );

        if (
            !room.started &&
            room.sockets.length === 0
        ) {
            delete rooms[roomId];
            return;
        }

        if (
            room.started &&
            room.sockets.length === 0
        ) {
            delete rooms[roomId];
            return;
        }

        if (room.started) {

            io.to(roomId).emit(
                "systemMessage",
                "A player disconnected. The room is closed."
            );

            room.sockets.forEach(s => {
                s.emit(
                    "roomError",
                    "A player disconnected. Please start a new match."
                );
                s.leave(roomId);
                s.gameRoom = null;
            });

            delete rooms[roomId];
        }
    });
});

server.listen(PORT, () => {

    console.log(
        `Server running on http://localhost:${PORT}`
    );
});
