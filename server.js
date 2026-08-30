const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = {};

/*
    Ludo Twist board paths.

    Each player has 25 positions:
    0 = starting position
    24 = HOME
*/
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

function makeRoom(roomId, maxPlayers, isPrivate = false) {
    return {
        id: roomId,
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
    return socket.gameRoom ? rooms[socket.gameRoom] : null;
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

function sendRoomMessage(room, message) {
    if (room) {
        io.to(room.id).emit("systemMessage", message);
    }
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

function validPlayerForSocket(room, socket, playerId) {
    return (
        room &&
        socket.gameRoom === room.id &&
        socket.playerIndex === playerId &&
        room.players.some(p => p.id === playerId)
    );
}

function currentPlayer(room) {
    return room.players[room.activeIndex];
}

function hasValidMove(player, roll) {
    return player.pawns.some(step => {
        return player.hasKilled
            ? step + roll <= 24
            : step + roll <= 15;
    });
}

function getNextActiveIndex(room) {
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

    room.activeIndex = getNextActiveIndex(room);

    const player = currentPlayer(room);

    if (player) {
        sendRoomMessage(
            room,
            `${player.name}'s turn.`
        );
    }

    sendState(room);
}

function setupRoom(roomId, socketsArray) {
    let room = rooms[roomId];

    if (!room) {
        room = makeRoom(
            roomId,
            socketsArray.length,
            false
        );

        rooms[roomId] = room;
    }

    room.sockets = socketsArray;

    const assignedIds = [0, 1, 2, 3].slice(
        0,
        socketsArray.length
    );

    room.players = [];

    socketsArray.forEach((socket, index) => {
        const playerId = assignedIds[index];

        socket.gameRoom = roomId;
        socket.playerIndex = playerId;

        room.players.push(makePlayer(playerId));

        socket.join(roomId);

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

    io.to(roomId).emit("gameStart", {
        players: assignedIds
    });

    sendRoomMessage(
        room,
        "Match started! Blue goes first."
    );

    sendState(room);
}

function destroyRoom(roomId, reason) {
    const room = rooms[roomId];

    if (!room) return;

    io.to(roomId).emit(
        "roomClosed",
        reason || "The room has been closed."
    );

    room.sockets.forEach(socket => {
        socket.leave(roomId);
        socket.gameRoom = null;
        socket.playerIndex = null;
    });

    delete rooms[roomId];
}

io.on("connection", socket => {

    console.log("Connected:", socket.id);

    /*
        PUBLIC MATCHMAKING
    */
    socket.on("joinGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit("roomError", "Invalid player count.");
            return;
        }

        removeFromQueues(socket.id);

        publicQueues[numPlayers].push(socket);

        const queue = publicQueues[numPlayers];

        if (queue.length >= numPlayers) {

            const matchedSockets =
                queue.splice(0, numPlayers);

            const roomId =
                "pub_" +
                Math.random()
                    .toString(36)
                    .substring(2, 8);

            rooms[roomId] =
                makeRoom(roomId, numPlayers, false);

            setupRoom(roomId, matchedSockets);

        } else {

            socket.emit(
                "systemMessage",
                `Waiting for ${numPlayers - queue.length} more player(s)...`
            );
        }
    });

    /*
        CREATE PRIVATE ROOM
    */
    socket.on("createPrivateGame", numPlayers => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit(
                "roomError",
                "Invalid player count."
            );
            return;
        }

        removeFromQueues(socket.id);

        const code = generateRoomCode();

        const room =
            makeRoom(code, numPlayers, true);

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
            "systemMessage",
            `Room created. Share code ${code}`
        );
    });

    /*
        JOIN PRIVATE ROOM
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

        sendRoomMessage(
            room,
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
    });

    /*
        SERVER-AUTHORITATIVE DICE ROLL
    */
    socket.on("requestRoll", () => {

        const room = getRoom(socket);

        if (!room || !room.started) return;

        const player = currentPlayer(room);

        if (!player) return;

        /*
            IMPORTANT:
            Only the socket assigned to the current
            player can roll.
        */
        if (
            socket.playerIndex !== player.id
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
                "You cannot roll right now."
            );
            return;
        }

        /*
            Server generates the dice value.
        */
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
                    Math.random() *
                    values.length
                )
            ];

        room.canRoll = false;
        room.activeRolls.push(roll);

        /*
            4 and 8 give another roll after the move.
        */
        if (
            roll === 4 ||
            roll === 8
        ) {
            room.canRoll = true;
        }

        io.to(room.id).emit(
            "diceRolled",
            {
                playerId: player.id,
                value: roll
            }
        );

        /*
            If no pawn can use the roll:
        */
        if (!hasValidMove(player, roll)) {

            room.activeRolls.shift();

            if (
                roll === 4 ||
                roll === 8
            ) {
                room.canRoll = true;

                sendRoomMessage(
                    room,
                    `${player.name} rolled ${roll}, but has no valid move. Extra roll!`
                );

                sendState(room);

            } else {

                sendRoomMessage(
                    room,
                    `${player.name} rolled ${roll}. No valid move.`
                );

                advanceTurn(room);
            }

            return;
        }

        sendRoomMessage(
            room,
            `${player.name} rolled ${roll}.`
        );

        sendState(room);
    });

    /*
        SERVER-AUTHORITATIVE MOVE
    */
    socket.on("requestMove", data => {

        const room = getRoom(socket);

        if (!room || !room.started) return;

        const playerId =
            Number(data?.playerId);

        const pawnIndex =
            Number(data?.pawnIndex);

        /*
            Prevent one player from controlling another player.
        */
        if (
            !validPlayerForSocket(
                room,
                socket,
                playerId
            )
        ) {
            socket.emit(
                "actionError",
                "You cannot control this player."
            );
            return;
        }

        const player =
            currentPlayer(room);

        if (!player) return;

        if (player.id !== playerId) {
            socket.emit(
                "actionError",
                "It is not your turn."
            );
            return;
        }

        if (
            !Number.isInteger(pawnIndex) ||
            pawnIndex < 0 ||
            pawnIndex > 3
        ) {
            return;
        }

        if (room.activeRolls.length === 0) {
            socket.emit(
                "actionError",
                "There is no active roll."
            );
            return;
        }

        const roll =
            room.activeRolls[0];

        const oldStep =
            player.pawns[pawnIndex];

        const maxStep =
            player.hasKilled ? 24 : 15;

        if (
            oldStep + roll >
            maxStep
        ) {
            socket.emit(
                "actionError",
                "That pawn cannot move."
            );
            return;
        }

        /*
            Consume the roll.
        */
        room.activeRolls.shift();

        const newStep =
            oldStep + roll;

        player.pawns[pawnIndex] =
            newStep;

        let captured = [];
        let earnedExtraTurn = false;

        const targetCell =
            allPlayers[player.id]
                .path[newStep];

        /*
            HOME
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

                sendRoomMessage(
                    room,
                    `${player.name} finished in position ${player.winRank}!`
                );
            } else {
                earnedExtraTurn = true;

                sendRoomMessage(
                    room,
                    `${player.name} reached HOME! Extra turn!`
                );
            }
        }

        /*
            CAPTURE
        */
        const safeCells =
            [2, 10, 14, 22, 12];

        if (
            !safeCells.includes(targetCell)
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
                            allPlayers[
                                opponent.id
                            ].path[
                                opponentStep
                            ] === targetCell
                        ) {

                            captured.push({
                                playerId:
                                    opponent.id,
                                pawnIndex:
                                    index
                            });

                            opponent.pawns[index] =
                                0;

                            player.hasKilled =
                                true;

                            earnedExtraTurn =
                                true;
                        }
                    }
                );
            });
        }

        /*
            Decide next action.
        */
        if (
            player.hasWon
        ) {

            if (
                room.players.filter(
                    p => !p.hasWon
                ).length <= 1
            ) {

                sendState(room);

                io.to(room.id).emit(
                    "gameFinished"
                );

                return;
            }

            room.activeRolls = [];
            room.canRoll = true;
            room.activeIndex =
                getNextActiveIndex(room);

        } else if (
            earnedExtraTurn
        ) {

            /*
                Extra turn from HOME or capture.
            */
            room.canRoll = true;

        } else if (
            room.activeRolls.length > 0
        ) {

            /*
                This normally won't happen with the
                current one-roll-at-a-time system,
                but keeps the state safe.
            */
            room.canRoll = false;

        } else {

            /*
                Normal move = next player's turn.
            */
            room.canRoll = true;
            room.activeIndex =
                getNextActiveIndex(room);
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
        CHAT
    */
    socket.on(
        "sendChatMessage",
        data => {

            const room =
                getRoom(socket);

            if (!room) return;

            const player =
                room.players.find(
                    p =>
                        p.id ===
                        socket.playerIndex
                );

            if (!player) return;

            const text =
                String(
                    data?.text || ""
                ).trim();

            if (!text) return;

            io.to(room.id).emit(
                "receiveChatMessage",
                {
                    name: player.name,
                    text: text.substring(0, 300)
                }
            );
        }
    );

    /*
        WEBRTC SIGNALING

        The server does NOT process microphone audio.
        It only passes WebRTC signaling messages
        between players in the same room.
    */
    socket.on(
        "voiceOffer",
        data => {

            const room =
                getRoom(socket);

            if (!room) return;

            socket.to(room.id).emit(
                "voiceOffer",
                {
                    from: socket.playerIndex,
                    offer: data.offer
                }
            );
        }
    );

    socket.on(
        "voiceAnswer",
        data => {

            const room =
                getRoom(socket);

            if (!room) return;

            socket.to(room.id).emit(
                "voiceAnswer",
                {
                    from: socket.playerIndex,
                    answer: data.answer
                }
            );
        }
    );

    socket.on(
        "iceCandidate",
        data => {

            const room =
                getRoom(socket);

            if (!room) return;

            socket.to(room.id).emit(
                "iceCandidate",
                {
                    from: socket.playerIndex,
                    candidate: data.candidate
                }
            );
        }
    );

    /*
        DISCONNECT
    */
    socket.on("disconnect", () => {

        console.log(
            "Disconnected:",
            socket.id
        );

        removeFromQueues(socket.id);

        const room =
            getRoom(socket);

        if (!room) return;

        /*
            For a running multiplayer game, close the room
            rather than allowing clients to develop different
            player lists.
        */
        destroyRoom(
            room.id,
            "A player disconnected. The match has ended."
        );
    });
});

const PORT =
    process.env.PORT || 3000;

server.listen(
    PORT,
    () => {
        console.log(
            `Server running on port ${PORT}`
        );
    }
);
