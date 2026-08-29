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

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = new Map();

const COLORS = [
    { id: 0, name: "Blue" },
    { id: 1, name: "Red" },
    { id: 2, name: "Green" },
    { id: 3, name: "Yellow" }
];

const PATHS = [
    [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],
    [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],
    [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],
    [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
];

const SAFE_CELLS = new Set([2, 10, 14, 22, 12]);

function newPlayer(id) {
    return {
        id,
        pawns: [0, 0, 0, 0],
        hasKilled: false,
        hasWon: false,
        winRank: 0
    };
}

function createGame(playerIds) {
    return {
        playerIds: [...playerIds],
        players: playerIds.map(newPlayer),
        activeIndex: 0,
        activeRolls: [],
        canRoll: true,
        rank: 1,
        started: true
    };
}

function cloneState(game) {
    return {
        playerIds: game.playerIds,
        players: game.players.map(p => ({
            id: p.id,
            pawns: [...p.pawns],
            hasKilled: p.hasKilled,
            hasWon: p.hasWon,
            winRank: p.winRank
        })),
        activeIndex: game.activeIndex,
        activeRolls: [...game.activeRolls],
        canRoll: game.canRoll,
        rank: game.rank
    };
}

function roomForSocket(socket) {
    return socket.data.roomId || null;
}

function emitState(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;

    io.to(roomId).emit("state", cloneState(room.game));
}

function sendStatus(roomId, text) {
    io.to(roomId).emit("systemMessage", text);
}

function rollValue() {
    const values = [1,1,2,2,3,3,4,8];
    return values[Math.floor(Math.random() * values.length)];
}

function currentPlayer(game) {
    return game.players[game.activeIndex];
}

function hasValidMove(player, roll) {
    return player.pawns.some(step => {
        const limit = player.hasKilled ? 24 : 15;
        return step + roll <= limit;
    });
}

function advanceTurn(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;

    const game = room.game;

    game.activeRolls = [];
    game.canRoll = true;

    if (game.players.every(p => p.hasWon)) {
        sendStatus(roomId, "Game finished!");
        emitState(roomId);
        return;
    }

    let attempts = 0;

    do {
        game.activeIndex =
            (game.activeIndex + 1) % game.players.length;

        attempts++;

        if (attempts > game.players.length + 2) break;

    } while (game.players[game.activeIndex].hasWon);

    const p = currentPlayer(game);

    sendStatus(roomId, `${COLORS[p.id].name}'s turn! Roll.`);

    emitState(roomId);
}

function finishRoll(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;

    const game = room.game;
    const player = currentPlayer(game);

    while (game.activeRolls.length > 0) {
        const r = game.activeRolls[0];

        if (hasValidMove(player, r)) break;

        game.activeRolls.shift();

        sendStatus(
            roomId,
            `${COLORS[player.id].name}: ${r} blocked.`
        );
    }

    if (game.activeRolls.length === 0 && !game.canRoll) {
        sendStatus(
            roomId,
            `${COLORS[player.id].name} has no move. Turn over!`
        );

        emitState(roomId);

        setTimeout(() => {
            const latest = rooms.get(roomId);
            if (!latest || !latest.game) return;

            if (
                latest.game.activeIndex ===
                game.activeIndex
            ) {
                advanceTurn(roomId);
            }
        }, 900);

        return;
    }

    emitState(roomId);
}

function performRoll(roomId, socket) {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;

    const game = room.game;
    const player = currentPlayer(game);

    if (!player) return;

    if (socket.data.playerId !== player.id) {
        socket.emit("actionError", "It is not your turn.");
        return;
    }

    if (!game.canRoll) {
        socket.emit("actionError", "Move a pawn first.");
        return;
    }

    const value = rollValue();

    game.canRoll = value === 4 || value === 8;
    game.activeRolls.push(value);

    io.to(roomId).emit("rollResult", {
        playerId: player.id,
        rollValue: value
    });

    if (value === 4 || value === 8) {
        sendStatus(
            roomId,
            `${COLORS[player.id].name} rolled ${value}. Extra roll!`
        );
    } else {
        sendStatus(
            roomId,
            `${COLORS[player.id].name} rolled ${value}.`
        );
    }

    finishRoll(roomId);
}

function performMove(roomId, socket, pawnIndex) {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;

    const game = room.game;
    const player = currentPlayer(game);

    if (!player) return;

    if (socket.data.playerId !== player.id) {
        socket.emit("actionError", "It is not your turn.");
        return;
    }

    if (
        !Number.isInteger(pawnIndex) ||
        pawnIndex < 0 ||
        pawnIndex > 3
    ) {
        return;
    }

    if (game.activeRolls.length === 0) {
        socket.emit("actionError", "Roll the dice first.");
        return;
    }

    const roll = game.activeRolls[0];
    const limit = player.hasKilled ? 24 : 15;

    if (player.pawns[pawnIndex] + roll > limit) {
        socket.emit("actionError", "That pawn cannot move.");
        return;
    }

    game.activeRolls.shift();

    const startStep = player.pawns[pawnIndex];
    const targetStep = Math.min(
        startStep + roll,
        24
    );

    player.pawns[pawnIndex] = targetStep;

    const pathCell = PATHS[player.id][targetStep];

    let captured = false;

    if (!SAFE_CELLS.has(pathCell) && targetStep < 24) {
        for (const opponent of game.players) {
            if (
                opponent.id === player.id ||
                opponent.hasWon
            ) continue;

            for (let i = 0; i < opponent.pawns.length; i++) {
                const oppStep = opponent.pawns[i];

                if (
                    oppStep < 24 &&
                    PATHS[opponent.id][oppStep] === pathCell
                ) {
                    opponent.pawns[i] = 0;
                    captured = true;
                }
            }
        }
    }

    if (captured) {
        player.hasKilled = true;
    }

    let reachedHome = targetStep === 24;

    let completed = false;

    if (
        reachedHome &&
        player.pawns.every(step => step === 24)
    ) {
        player.hasWon = true;
        player.winRank = game.rank++;
        completed = true;
    }

    io.to(roomId).emit("moveResult", {
        playerId: player.id,
        pawnIndex,
        startStep,
        targetStep,
        roll,
        captured,
        reachedHome,
        completed
    });

    if (completed) {
        sendStatus(
            roomId,
            `${COLORS[player.id].name} finished in rank ${player.winRank}!`
        );
    }

    if (game.activeRolls.length > 0) {
        game.canRoll = true;
        sendStatus(
            roomId,
            `${COLORS[player.id].name}: choose another move.`
        );
        emitState(roomId);
        return;
    }

    if (captured || reachedHome) {
        game.canRoll = true;

        sendStatus(
            roomId,
            captured
                ? `${COLORS[player.id].name} captured a pawn! Extra turn!`
                : `${COLORS[player.id].name} reached HOME! Extra turn!`
        );

        emitState(roomId);
        return;
    }

    if (completed) {
        advanceTurn(roomId);
        return;
    }

    game.canRoll = false;

    emitState(roomId);

    setTimeout(() => {
        const latest = rooms.get(roomId);

        if (!latest || !latest.game) return;

        if (
            latest.game.activeIndex === game.activeIndex &&
            latest.game.activeRolls.length === 0 &&
            !latest.game.canRoll
        ) {
            advanceTurn(roomId);
        }
    }, 700);
}

function removeSocketFromQueues(socketId) {
    for (const key of Object.keys(publicQueues)) {
        publicQueues[key] = publicQueues[key].filter(
            s => s.id !== socketId
        );
    }
}

function makeRoomCode() {
    let code;

    do {
        code = Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase();
    } while (rooms.has(code));

    return code;
}

function setupRoom(roomId, sockets) {
    const ids = [0,1,2,3].slice(
        0,
        sockets.length
    );

    const room = rooms.get(roomId) || {
        id: roomId,
        sockets: [],
        private: false
    };

    room.sockets = sockets;
    room.game = createGame(ids);
    room.started = true;

    rooms.set(roomId, room);

    sockets.forEach((socket, index) => {
        socket.data.roomId = roomId;
        socket.data.playerId = ids[index];

        socket.join(roomId);

        socket.emit(
            "assignPlayer",
            ids[index]
        );
    });

    io.to(roomId).emit(
        "gameStart",
        ids
    );

    sendStatus(
        roomId,
        "Match started! Blue goes first."
    );

    emitState(roomId);
}

io.on("connection", socket => {

    console.log(
        "Connected:",
        socket.id
    );

    socket.on("joinGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2,3,4].includes(numPlayers)) {
            return;
        }

        removeSocketFromQueues(socket.id);

        publicQueues[numPlayers].push(socket);

        if (
            publicQueues[numPlayers].length >=
            numPlayers
        ) {
            const matched =
                publicQueues[numPlayers]
                    .splice(0, numPlayers);

            const roomId =
                "pub_" +
                Math.random()
                    .toString(36)
                    .substring(2,8);

            rooms.set(roomId, {
                id: roomId,
                sockets: matched,
                private: false,
                started: false
            });

            setupRoom(roomId, matched);
        } else {

            socket.emit(
                "systemMessage",
                `Waiting for ${
                    numPlayers -
                    publicQueues[numPlayers].length
                } more player(s)...`
            );
        }
    });

    socket.on(
        "createPrivateGame",
        numPlayers => {

            numPlayers = Number(numPlayers);

            if (![2,3,4].includes(numPlayers)) {
                return;
            }

            removeSocketFromQueues(socket.id);

            const code = makeRoomCode();

            rooms.set(code, {
                id: code,
                sockets: [socket],
                private: true,
                maxPlayers: numPlayers,
                started: false
            });

            socket.data.roomId = code;

            socket.join(code);

            socket.emit(
                "privateRoomCreated",
                code
            );

            sendStatus(
                code,
                `Private room ${code} created.`
            );
        }
    );

    socket.on(
        "joinPrivateGame",
        rawCode => {

            const code =
                String(rawCode)
                    .trim()
                    .toUpperCase();

            const room = rooms.get(code);

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

            removeSocketFromQueues(socket.id);

            room.sockets.push(socket);

            socket.data.roomId = code;

            socket.join(code);

            sendStatus(
                code,
                `Player joined (${room.sockets.length}/${room.maxPlayers})...`
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
        }
    );

    socket.on(
        "requestRoll",
        () => {

            const roomId =
                roomForSocket(socket);

            if (!roomId) return;

            performRoll(
                roomId,
                socket
            );
        }
    );

    socket.on(
        "requestMove",
        data => {

            const roomId =
                roomForSocket(socket);

            if (!roomId) return;

            performMove(
                roomId,
                socket,
                Number(data.pawnIndex)
            );
        }
    );

    socket.on(
        "sendChatMessage",
        data => {

            const roomId =
                roomForSocket(socket);

            if (!roomId) return;

            const name =
                String(data.name || "Player")
                    .substring(0, 30);

            const text =
                String(data.text || "")
                    .trim()
                    .substring(0, 300);

            if (!text) return;

            io.to(roomId).emit(
                "receiveChatMessage",
                {
                    name,
                    text
                }
            );
        }
    );

    socket.on(
        "voiceData",
        data => {

            const roomId =
                roomForSocket(socket);

            if (!roomId) return;

            socket
                .to(roomId)
                .emit(
                    "voiceData",
                    data
                );
        }
    );

    socket.on(
        "disconnect",
        () => {

            removeSocketFromQueues(
                socket.id
            );

            const roomId =
                socket.data.roomId;

            if (!roomId) {
                console.log(
                    "Disconnected:",
                    socket.id
                );
                return;
            }

            const room =
                rooms.get(roomId);

            if (!room) return;

            room.sockets =
                room.sockets.filter(
                    s => s.id !== socket.id
                );

            if (
                room.sockets.length === 0
            ) {
                rooms.delete(roomId);
                return;
            }

            if (room.started) {
                io.to(roomId).emit(
                    "systemMessage",
                    "A player disconnected."
                );
            }

            console.log(
                "Disconnected:",
                socket.id
            );
        }
    );
});

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
