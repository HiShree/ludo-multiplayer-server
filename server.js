const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: true }
});

app.use(express.static(path.join(__dirname)));

const publicQueues = {
    2: [],
    3: [],
    4: []
};

const rooms = new Map();

const BASE_PLAYERS = [
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

const SAFE_CELLS = new Set([
    2, 10, 14, 22, 12
]);

const DICE_VALUES = [
    1, 1,
    2, 2,
    3, 3,
    4, 8
];

function createPlayer(id) {
    const base = BASE_PLAYERS[id];

    return {
        id: base.id,
        name: base.name,
        color: base.color,
        path: [...base.path],
        pawns: [0, 0, 0, 0],
        hasKilled: false,
        hasWon: false,
        winRank: 0
    };
}

function createGameState(ids) {
    return {
        activeId: ids[0],
        roll: null,
        canRoll: true,
        busy: false,
        currentRank: 1,
        players: ids.map(createPlayer)
    };
}

function publicState(room) {
    const state = room.state;

    return {
        activeId: state.activeId,
        roll: state.roll,
        canRoll: state.canRoll,
        busy: state.busy,
        currentRank: state.currentRank,

        players: state.players.map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            pawns: [...p.pawns],
            hasKilled: p.hasKilled,
            hasWon: p.hasWon,
            winRank: p.winRank
        }))
    };
}

function emitState(room) {
    io.to(room.id).emit("state", publicState(room));
}

function status(room, message) {
    io.to(room.id).emit("systemMessage", message);
}

function getRoom(socket) {
    if (!socket.room) return null;
    return rooms.get(socket.room) || null;
}

function getPlayer(room, id) {
    return room.state.players.find(p => p.id === id);
}

function getCurrentPlayer(room) {
    return getPlayer(room, room.state.activeId);
}

function isValidMove(player, pawnStep, roll) {
    const limit = player.hasKilled ? 24 : 15;
    return pawnStep + roll <= limit;
}

function hasValidMove(player, roll) {
    return player.pawns.some(step =>
        isValidMove(player, step, roll)
    );
}

function moveToNextPlayer(room) {
    const state = room.state;

    const currentIndex =
        state.players.findIndex(p => p.id === state.activeId);

    let index = currentIndex;

    do {
        index = (index + 1) % state.players.length;
    } while (
        state.players[index].hasWon &&
        index !== currentIndex
    );

    state.activeId = state.players[index].id;

    state.roll = null;
    state.canRoll = true;
    state.busy = false;
}

function finishTurn(room, extraTurn, message) {

    const state = room.state;

    state.roll = null;
    state.busy = false;

    if (extraTurn) {

        state.canRoll = true;

        status(
            room,
            message ||
            `${getCurrentPlayer(room).name}'s extra turn!`
        );

        emitState(room);

        maybeBot(room);

    } else {

        state.canRoll = false;

        status(
            room,
            message || "Turn over!"
        );

        emitState(room);

        setTimeout(() => {

            if (!rooms.has(room.id)) return;

            moveToNextPlayer(room);

            emitState(room);

            status(
                room,
                `${getCurrentPlayer(room).name}'s turn.`
            );

            maybeBot(room);

        }, 700);
    }
}

function performMove(room, socket, pawnIndex) {

    const state = room.state;
    const player = getCurrentPlayer(room);
    const roll = state.roll;

    if (!player) return;

    if (state.busy) return;

    if (!state.canRoll) return;

    if (roll === null) return;

    if (socket.playerIndex !== state.activeId) return;

    if (
        !Number.isInteger(pawnIndex) ||
        pawnIndex < 0 ||
        pawnIndex > 3
    ) {
        return;
    }

    if (!isValidMove(
        player,
        player.pawns[pawnIndex],
        roll
    )) {
        return;
    }

    state.busy = true;
    state.canRoll = false;

    emitState(room);

    status(
        room,
        `${player.name} is moving...`
    );

    let remaining = roll;

    function hop() {

        if (remaining > 0) {

            player.pawns[pawnIndex]++;

            remaining--;

            io.to(room.id).emit(
                "moveStep",
                {
                    playerId: player.id,
                    pawnIndex,
                    step: player.pawns[pawnIndex]
                }
            );

            emitState(room);

            setTimeout(hop, 150);

            return;
        }

        finishMovement(room, player, pawnIndex, roll);
    }

    hop();
}

function finishMovement(room, player, pawnIndex, roll) {

    const state = room.state;

    const finalCell =
        player.path[player.pawns[pawnIndex]];

    let extraTurn =
        roll === 4 ||
        roll === 8;

    let message =
        extraTurn
            ? `${player.name} rolled ${roll}. Extra turn!`
            : null;

    /*
       HOME RULE
    */

    if (player.pawns[pawnIndex] === 24) {

        if (
            player.pawns.every(
                step => step === 24
            )
        ) {

            player.hasWon = true;
            player.winRank = state.currentRank++;

            io.to(room.id).emit(
                "playerWon",
                {
                    playerId: player.id,
                    rank: player.winRank
                }
            );

            const remaining =
                state.players.filter(
                    p => !p.hasWon
                );

            if (remaining.length <= 1) {

                state.roll = null;
                state.busy = false;
                state.canRoll = false;

                emitState(room);

                status(
                    room,
                    `${player.name} wins the game!`
                );

                return;
            }

            extraTurn = true;

            message =
                `${player.name} finished all pawns! Extra turn!`;

        } else {

            extraTurn = true;

            message =
                "Pawn Home! Extra Turn!";
        }
    }

    /*
       CAPTURE RULE
    */

    if (!SAFE_CELLS.has(finalCell)) {

        for (const opponent of state.players) {

            if (opponent.id === player.id) continue;
            if (opponent.hasWon) continue;

            for (let i = 0; i < 4; i++) {

                if (
                    opponent.pawns[i] < 24 &&
                    opponent.path[
                        opponent.pawns[i]
                    ] === finalCell
                ) {

                    player.hasKilled = true;

                    extraTurn = true;

                    message =
                        "Captured! Extra Turn!";

                    capturePawn(
                        room,
                        opponent,
                        i,
                        () => {
                            finishTurn(
                                room,
                                extraTurn,
                                message
                            );
                        }
                    );

                    return;
                }
            }
        }
    }

    finishTurn(
        room,
        extraTurn,
        message
    );
}

function capturePawn(room, opponent, pawnIndex, done) {

    let remaining =
        opponent.pawns[pawnIndex];

    function stepBack() {

        if (remaining > 0) {

            opponent.pawns[pawnIndex]--;

            remaining--;

            io.to(room.id).emit(
                "captureStep",
                {
                    playerId: opponent.id,
                    pawnIndex,
                    step: opponent.pawns[pawnIndex]
                }
            );

            emitState(room);

            setTimeout(
                stepBack,
                45
            );

        } else {

            done();
        }
    }

    stepBack();
}

function performRoll(room, socket) {

    const state = room.state;
    const player = getCurrentPlayer(room);

    if (!player) return;

    if (state.busy) return;

    if (!state.canRoll) return;

    if (state.roll !== null) return;

    if (socket.playerIndex !== state.activeId) return;

    const value =
        DICE_VALUES[
            Math.floor(
                Math.random() *
                DICE_VALUES.length
            )
        ];

    state.roll = value;
    state.canRoll = false;

    emitState(room);

    io.to(room.id).emit(
        "rollResult",
        {
            playerId: player.id,
            value
        }
    );

    if (!hasValidMove(player, value)) {

        status(
            room,
            `${player.name} rolled ${value}. No valid move.`
        );

        setTimeout(() => {

            if (!rooms.has(room.id)) return;

            if (
                room.state.roll === value &&
                !room.state.busy
            ) {
                finishTurn(
                    room,
                    false,
                    "No moves. Turn over!"
                );
            }

        }, 700);

    } else {

        status(
            room,
            `${player.name} rolled ${value}. Choose a pawn.`
        );
    }
}

/*
   BOT
*/

function maybeBot(room) {

    if (room.mode !== "local")
        return;

    const player =
        getCurrentPlayer(room);

    if (!player || !player.isBot)
        return;

    if (room.botTimer)
        return;

    room.botTimer =
        setTimeout(() => {

            room.botTimer = null;

            if (!rooms.has(room.id))
                return;

            const state = room.state;

            if (state.activeId !== player.id)
                return;

            if (state.busy)
                return;

            if (
                state.roll === null &&
                state.canRoll
            ) {

                performRoll(
                    room,
                    {
                        playerIndex: player.id
                    }
                );

                return;
            }

            if (
                state.roll !== null &&
                !state.busy
            ) {

                const choices =
                    player.pawns
                        .map((step, index) => ({
                            step,
                            index
                        }))
                        .filter(x =>
                            isValidMove(
                                player,
                                x.step,
                                state.roll
                            )
                        );

                if (choices.length) {

                    const selected =
                        choices[
                            Math.floor(
                                Math.random() *
                                choices.length
                            )
                        ];

                    performMove(
                        room,
                        {
                            playerIndex: player.id
                        },
                        selected.index
                    );
                }
            }

        }, 650);
}

/*
   CREATE ONLINE ROOM
*/

function setupRoom(
    roomId,
    sockets,
    maxPlayers,
    mode = "online"
) {

    const ids =
        sockets.map(
            (_, index) => index
        );

    const room = {
        id: roomId,
        maxPlayers,
        sockets: new Set(sockets),
        mode,
        state: createGameState(ids),
        started: true,
        botTimer: null
    };

    rooms.set(
        roomId,
        room
    );

    sockets.forEach(
        (socket, index) => {

            socket.room = roomId;
            socket.playerIndex = index;

            socket.join(roomId);

            socket.emit(
                "assignPlayer",
                index
            );
        }
    );

    io.to(roomId).emit(
        "gameStart",
        ids
    );

    emitState(room);

    status(
        room,
        "Match started! Blue goes first."
    );

    maybeBot(room);
}

function removeFromQueues(socketId) {

    for (const key of Object.keys(publicQueues)) {

        publicQueues[key] =
            publicQueues[key].filter(
                socket =>
                    socket.id !== socketId
            );
    }
}

function findRoom(socket) {

    if (!socket.room)
        return null;

    return rooms.get(
        socket.room
    ) || null;
}

/*
   SOCKET.IO
*/

io.on(
    "connection",
    socket => {

        console.log(
            "Connected:",
            socket.id
        );

        /*
           PUBLIC MATCHMAKING
        */

        socket.on(
            "joinGame",
            numPlayers => {

                removeFromQueues(
                    socket.id
                );

                if (!publicQueues[numPlayers])
                    return;

                publicQueues[numPlayers]
                    .push(socket);

                if (
                    publicQueues[numPlayers]
                        .length >= numPlayers
                ) {

                    const matched =
                        publicQueues[numPlayers]
                            .splice(
                                0,
                                numPlayers
                            );

                    const roomId =
                        "pub_" +
                        Math.random()
                            .toString(36)
                            .substring(2, 8);

                    setupRoom(
                        roomId,
                        matched,
                        numPlayers
                    );

                } else {

                    socket.emit(
                        "systemMessage",
                        `Waiting for ${
                            numPlayers -
                            publicQueues[numPlayers].length
                        } more players...`
                    );
                }
            }
        );

        /*
           PRIVATE ROOM
        */

        socket.on(
            "createPrivateGame",
            numPlayers => {

                removeFromQueues(
                    socket.id
                );

                const code =
                    Math.random()
                        .toString(36)
                        .substring(2, 8)
                        .toUpperCase();

                const room = {
                    id: code,
                    maxPlayers: numPlayers,
                    sockets: new Set([socket]),
                    mode: "online",
                    state: null,
                    started: false,
                    botTimer: null
                };

                rooms.set(
                    code,
                    room
                );

                socket.room = code;
                socket.join(code);

                socket.emit(
                    "privateRoomCreated",
                    code
                );
            }
        );

        socket.on(
            "joinPrivateGame",
            code => {

                code =
                    String(code || "")
                        .trim()
                        .toUpperCase();

                const room =
                    rooms.get(code);

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
                    room.sockets.size >=
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

                room.sockets.add(
                    socket
                );

                socket.room = code;

                socket.join(code);

                io.to(code).emit(
                    "systemMessage",
                    `Player joined (${room.sockets.size}/${room.maxPlayers})...`
                );

                if (
                    room.sockets.size ===
                    room.maxPlayers
                ) {

                    setupRoom(
                        code,
                        [...room.sockets],
                        room.maxPlayers
                    );
                }
            }
        );

        /*
           GAME REQUESTS
        */

        socket.on(
            "requestRoll",
            () => {

                const room =
                    findRoom(socket);

                if (
                    room &&
                    room.started
                ) {

                    performRoll(
                        room,
                        socket
                    );
                }
            }
        );

        socket.on(
            "requestMove",
            data => {

                const room =
                    findRoom(socket);

                if (
                    room &&
                    room.started
                ) {

                    performMove(
                        room,
                        socket,
                        Number(
                            data?.pawnIndex
                        )
                    );
                }
            }
        );

        /*
           CHAT
        */

        socket.on(
            "sendChatMessage",
            data => {

                const room =
                    findRoom(socket);

                if (!room)
                    return;

                io.to(room.id).emit(
                    "receiveChatMessage",
                    {
                        name:
                            String(
                                data?.name ||
                                "Player"
                            ).slice(0, 30),

                        text:
                            String(
                                data?.text ||
                                ""
                            ).slice(0, 200)
                    }
                );
            }
        );

        /*
           WEBRTC VOICE SIGNALING
        */

        socket.on(
            "voiceReady",
            () => {

                const room =
                    findRoom(socket);

                if (!room)
                    return;

                const peers =
                    [...room.sockets]
                        .filter(
                            s =>
                                s.id !==
                                socket.id
                        )
                        .map(
                            s => s.id
                        );

                socket.emit(
                    "voicePeers",
                    peers
                );

                socket
                    .to(room.id)
                    .emit(
                        "voicePeer",
                        socket.id
                    );
            }
        );

        socket.on(
            "voiceSignal",
            data => {

                const room =
                    findRoom(socket);

                if (
                    !room ||
                    !data?.to
                ) {
                    return;
                }

                const target =
                    [...room.sockets]
                        .find(
                            s =>
                                s.id ===
                                data.to
                        );

                if (!target)
                    return;

                target.emit(
                    "voiceSignal",
                    {
                        from: socket.id,
                        description:
                            data.description,
                        candidate:
                            data.candidate
                    }
                );
            }
        );

        /*
           DISCONNECT
        */

        socket.on(
            "disconnect",
            () => {

                removeFromQueues(
                    socket.id
                );

                const room =
                    findRoom(socket);

                if (!room)
                    return;

                room.sockets.delete(
                    socket
                );

                if (room.started) {

                    io.to(room.id).emit(
                        "systemMessage",
                        "A player disconnected."
                    );

                } else if (
                    room.sockets.size === 0
                ) {

                    rooms.delete(
                        room.id
                    );
                }

                console.log(
                    "Disconnected:",
                    socket.id
                );
            }
        );
    }
);

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
