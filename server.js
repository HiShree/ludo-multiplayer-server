const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

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
    [10,15,20,21,22,23,24,19,14,9,4,3,2,1,0,5,6,7,8,13,18,17,16,11,12],
    [2,1,0,5,10,15,20,21,22,23,24,19,14,9,4,3,8,13,18,17,16,11,6,7,12],
    [14,9,4,3,2,1,0,5,10,15,20,21,22,23,24,19,18,17,16,11,6,7,8,13,12],
    [22,23,24,19,14,9,4,3,2,1,0,5,10,15,20,21,16,11,6,7,8,13,18,17,12]
];

const SAFE = [2,10,12,14,22];

const DICE_VALUES = [
    1,1,
    2,2,
    3,3,
    4,
    8
];

const queues = {
    2: [],
    3: [],
    4: []
};

const rooms = new Map();


function makePlayer(id, index) {

    return {
        id,
        index,
        name: NAMES[index],
        color: COLORS[index],

        pawns: [0,0,0,0],

        hasKilled: false,
        finished: false,

        lastRoll: null
    };

}


function isValidMove(player, pawnIndex, roll) {

    if (!player) return false;

    if (
        pawnIndex < 0 ||
        pawnIndex > 3
    ) {
        return false;
    }

    const step = player.pawns[pawnIndex];

    if (step >= 24) {
        return false;
    }

    const maximum =
        player.hasKilled
            ? 24
            : 15;

    return step + roll <= maximum;
}


function performCapture(room, player, toStep) {

    if (toStep >= 24) {
        return false;
    }

    const boardCell =
        PATHS[player.index][toStep];

    if (SAFE.includes(boardCell)) {
        return false;
    }

    let captured = false;

    for (const opponent of room.players) {

        if (opponent.index === player.index) {
            continue;
        }

        for (let i = 0; i < opponent.pawns.length; i++) {

            const opponentStep =
                opponent.pawns[i];

            if (
                opponentStep > 0 &&
                opponentStep < 24 &&
                PATHS[opponent.index][opponentStep] === boardCell
            ) {

                opponent.pawns[i] = 0;
                captured = true;
            }

        }
    }

    if (captured) {
        player.hasKilled = true;
    }

    return captured;
}


function getPublicState(room) {

    return {

        roomId: room.id,

        mode: room.mode,

        maxPlayers: room.maxPlayers,

        started: room.started,

        currentIndex: room.currentIndex,

        players: room.players.map(player => ({

            id: player.id,

            index: player.index,

            name: player.name,

            color: player.color,

            pawns: [...player.pawns],

            finished: player.finished,

            lastRoll: player.lastRoll

        }))

    };

}


function sendState(room) {

    io.to(room.id).emit(
        "gameState",
        getPublicState(room)
    );

}


function sendMessage(room, message) {

    io.to(room.id).emit(
        "systemMessage",
        message
    );

}


function checkGameFinished(player) {

    return player.pawns.every(
        pawn => pawn >= 24
    );

}


function nextTurn(room) {

    if (!room.players.length) {
        return;
    }

    const total =
        room.players.length;

    for (
        let i = 1;
        i <= total;
        i++
    ) {

        const next =
            (room.currentIndex + i) % total;

        const player =
            room.players[next];

        if (!player.finished) {

            room.currentIndex = next;

            return;
        }
    }
}


function startRoom(room) {

    if (
        room.players.length <
        room.maxPlayers
    ) {
        return;
    }

    room.started = true;

    room.currentIndex = 0;

    room.rolls.clear();

    for (const player of room.players) {

        player.pawns = [0,0,0,0];

        player.hasKilled = false;

        player.finished = false;

        player.lastRoll = null;
    }

    io.to(room.id).emit(
        "gameStart",
        getPublicState(room)
    );

    sendState(room);

    sendMessage(
        room,
        `${room.players[0].name}'s turn`
    );
}


function leaveQueue(socketId) {

    for (const count of [2,3,4]) {

        queues[count] =
            queues[count].filter(
                id => id !== socketId
            );
    }
}


function removeSocketFromRoom(socketId) {

    for (const [roomId, room] of rooms.entries()) {

        const found =
            room.players.find(
                player =>
                    player.id === socketId
            );

        if (found) {

            rooms.delete(roomId);

            io.to(roomId).emit(
                "roomClosed",
                "The room was closed because a player left."
            );

            return true;
        }
    }

    return false;
}


function findRoomByPlayer(socketId) {

    for (const room of rooms.values()) {

        if (
            room.players.some(
                player =>
                    player.id === socketId
            )
        ) {
            return room;
        }
    }

    return null;
}


/* =========================================================
   PUBLIC MATCHMAKING
========================================================= */

function joinGame(socket, numPlayers) {

    numPlayers = Number(numPlayers);

    if (![2,3,4].includes(numPlayers)) {
        return;
    }

    leaveQueue(socket.id);

    let opponentId =
        queues[numPlayers].shift();

    if (!opponentId) {

        queues[numPlayers].push(
            socket.id
        );

        socket.emit(
            "waiting",
            `Waiting for ${numPlayers} players...`
        );

        return;
    }

    const players = [
        opponentId,
        socket.id
    ];

    const roomId =
        `pub_${numPlayers}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2,8)}`;

    const room = {

        id: roomId,

        mode: "public",

        maxPlayers: numPlayers,

        players: [],

        started: false,

        currentIndex: 0,

        rolls: new Map()
    };

    rooms.set(
        roomId,
        room
    );

    for (
        let i = 0;
        i < players.length;
        i++
    ) {

        const playerSocket =
            io.sockets.sockets.get(
                players[i]
            );

        if (!playerSocket) {
            continue;
        }

        playerSocket.join(roomId);

        const player =
            makePlayer(
                players[i],
                i
            );

        room.players.push(player);

        playerSocket.emit(
            "assignPlayer",
            {
                playerId: player.id,
                index: player.index,
                name: player.name,
                color: player.color
            }
        );
    }

    /*
       IMPORTANT:
       This server currently pairs players
       two at a time. For a 3/4 player public
       room, private rooms should be used.
    */

    if (
        room.players.length ===
        room.maxPlayers
    ) {

        startRoom(room);
    }
}


/* =========================================================
   PRIVATE ROOMS
========================================================= */

function createPrivateGame(
    socket,
    numPlayers
) {

    numPlayers =
        Number(numPlayers);

    if (![2,3,4].includes(numPlayers)) {
        return;
    }

    removeSocketFromRoom(
        socket.id
    );

    leaveQueue(
        socket.id
    );

    const code =
        Math.random()
            .toString(36)
            .substring(2,8)
            .toUpperCase();

    const room = {

        id: `private_${code}`,

        code,

        mode: "private",

        maxPlayers: numPlayers,

        players: [],

        started: false,

        currentIndex: 0,

        rolls: new Map()
    };

    const player =
        makePlayer(
            socket.id,
            0
        );

    room.players.push(
        player
    );

    rooms.set(
        room.id,
        room
    );

    socket.join(
        room.id
    );

    socket.emit(
        "assignPlayer",
        {
            playerId: player.id,
            index: player.index,
            name: player.name,
            color: player.color
        }
    );

    socket.emit(
        "privateRoomCreated",
        code
    );

    sendState(room);
}


function joinPrivateGame(
    socket,
    code
) {

    code =
        String(code || "")
            .trim()
            .toUpperCase();

    const room =
        [...rooms.values()]
            .find(
                r =>
                    r.mode === "private" &&
                    r.code === code
            );

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
            "Game already started."
        );

        return;
    }

    if (
        room.players.length >=
        room.maxPlayers
    ) {

        socket.emit(
            "roomError",
            "Room is full."
        );

        return;
    }

    const index =
        room.players.length;

    const player =
        makePlayer(
            socket.id,
            index
        );

    room.players.push(
        player
    );

    socket.join(
        room.id
    );

    socket.emit(
        "assignPlayer",
        {
            playerId: player.id,
            index: player.index,
            name: player.name,
            color: player.color
        }
    );

    sendMessage(
        room,
        `${player.name} joined the room.`
    );

    sendState(room);

    if (
        room.players.length ===
        room.maxPlayers
    ) {

        startRoom(room);
    }
}


/* =========================================================
   CONNECTION
========================================================= */

io.on(
    "connection",
    socket => {

        socket.on(
            "joinPublicGame",
            numPlayers =>
                joinGame(
                    socket,
                    numPlayers
                )
        );

        /*
           Compatibility with your old
           client code.
        */

        socket.on(
            "joinGame",
            numPlayers =>
                joinGame(
                    socket,
                    numPlayers
                )
        );


        socket.on(
            "createPrivateGame",
            numPlayers =>
                createPrivateGame(
                    socket,
                    numPlayers
                )
        );


        socket.on(
            "joinPrivateGame",
            code =>
                joinPrivateGame(
                    socket,
                    code
                )
        );


        /* =================================================
           ROLL
        ================================================= */

        socket.on(
            "requestRoll",
            () => {

                const room =
                    findRoomByPlayer(
                        socket.id
                    );

                if (
                    !room ||
                    !room.started
                ) {
                    return;
                }

                const playerIndex =
                    room.players.findIndex(
                        player =>
                            player.id === socket.id
                    );

                if (
                    playerIndex !==
                    room.currentIndex
                ) {
                    return;
                }

                if (
                    room.rolls.has(
                        socket.id
                    )
                ) {
                    return;
                }

                const value =
                    DICE_VALUES[
                        Math.floor(
                            Math.random() *
                            DICE_VALUES.length
                        )
                    ];

                const rollId =
                    `${Date.now()}_${Math.random()
                        .toString(36)
                        .slice(2,7)}`;

                room.rolls.set(
                    socket.id,
                    {
                        id: rollId,
                        value
                    }
                );

                const player =
                    room.players[playerIndex];

                player.lastRoll =
                    value;

                io.to(room.id).emit(
                    "diceRolled",
                    {
                        playerId: player.index,
                        playerSocketId: player.id,
                        playerIndex: player.index,
                        value,
                        rollId,
                        extraAvailable:
                            value === 4 ||
                            value === 8
                    }
                );

                const validMoves = [];

                for (
                    let i = 0;
                    i < 4;
                    i++
                ) {

                    if (
                        isValidMove(
                            player,
                            i,
                            value
                        )
                    ) {

                        validMoves.push(i);
                    }
                }

                if (!validMoves.length) {

                    const extra =
                        value === 4 ||
                        value === 8;

                    room.rolls.delete(
                        socket.id
                    );

                    setTimeout(
                        () => {

                            if (
                                !room.started
                            ) {
                                return;
                            }

                            if (extra) {

                                io.to(room.id).emit(
                                    "extraTurn",
                                    {
                                        playerId:
                                            player.index,
                                        reason:
                                            "Extra roll"
                                    }
                                );

                                sendMessage(
                                    room,
                                    `${player.name} gets another roll.`
                                );

                            } else {

                                nextTurn(room);

                                sendState(room);

                                sendMessage(
                                    room,
                                    `${room.players[
                                        room.currentIndex
                                    ].name}'s turn`
                                );
                            }

                        },
                        900
                    );
                }
            }
        );


        /* =================================================
           MOVE
        ================================================= */

        socket.on(
            "requestMove",
            data => {

                const room =
                    findRoomByPlayer(
                        socket.id
                    );

                if (
                    !room ||
                    !room.started
                ) {
                    return;
                }

                const player =
                    room.players.find(
                        p =>
                            p.id === socket.id
                    );

                if (!player) {
                    return;
                }

                if (
                    room.currentIndex !==
                    player.index
                ) {
                    return;
                }

                const storedRoll =
                    room.rolls.get(
                        socket.id
                    );

                if (!storedRoll) {
                    return;
                }

                if (
                    storedRoll.id !==
                    data.rollId
                ) {
                    return;
                }

                const pawnIndex =
                    Number(
                        data.pawnIndex
                    );

                const roll =
                    Number(
                        storedRoll.value
                    );

                if (
                    !isValidMove(
                        player,
                        pawnIndex,
                        roll
                    )
                ) {
                    return;
                }

                const oldStep =
                    player.pawns[pawnIndex];

                const newStep =
                    oldStep + roll;

                player.pawns[pawnIndex] =
                    newStep;

                room.rolls.delete(
                    socket.id
                );

                const captured =
                    performCapture(
                        room,
                        player,
                        newStep
                    );

                const reachedHome =
                    newStep >= 24;

                if (reachedHome) {

                    player.pawns[pawnIndex] =
                        24;
                }

                if (
                    checkGameFinished(
                        player
                    )
                ) {

                    player.finished =
                        true;

                    io.to(room.id).emit(
                        "playerFinished",
                        {
                            playerId:
                                player.index,

                            playerIndex:
                                player.index,

                            name:
                                player.name
                        }
                    );

                    sendState(room);

                    return;
                }

                const extra =
                    roll === 4 ||
                    roll === 8 ||
                    captured ||
                    reachedHome;

                io.to(room.id).emit(
                    "moveResult",
                    {
                        playerId:
                            player.index,

                        playerSocketId:
                            player.id,

                        playerIndex:
                            player.index,

                        pawnIndex,

                        oldStep,

                        newStep:
                            player.pawns[pawnIndex],

                        from:
                            oldStep,

                        to:
                            player.pawns[pawnIndex],

                        roll,

                        captured,

                        reachedHome,

                        extra
                    }
                );

                sendState(room);

                setTimeout(
                    () => {

                        if (
                            !room.started
                        ) {
                            return;
                        }

                        if (extra) {

                            io.to(room.id).emit(
                                "extraTurn",
                                {
                                    playerId:
                                        player.index,

                                    reason:
                                        captured
                                            ? "Capture"
                                            : reachedHome
                                                ? "HOME"
                                                : "Extra roll"
                                }
                            );

                            sendMessage(
                                room,
                                `${player.name} gets another roll.`
                            );

                        } else {

                            nextTurn(room);

                            sendState(room);

                            const nextPlayer =
                                room.players[
                                    room.currentIndex
                                ];

                            sendMessage(
                                room,
                                `${nextPlayer.name}'s turn`
                            );
                        }

                    },
                    850
                );
            }
        );


        /* =================================================
           CHAT
        ================================================= */

        socket.on(
            "sendChatMessage",
            data => {

                const room =
                    findRoomByPlayer(
                        socket.id
                    );

                if (!room) {
                    return;
                }

                const player =
                    room.players.find(
                        p =>
                            p.id === socket.id
                    );

                if (!player) {
                    return;
                }

                const message =
                    typeof data === "string"
                        ? data
                        : data?.text;

                const text =
                    String(
                        message || ""
                    )
                    .trim()
                    .slice(0,150);

                if (!text) {
                    return;
                }

                io.to(room.id).emit(
                    "receiveChatMessage",
                    {
                        playerId:
                            player.index,

                        name:
                            player.name,

                        color:
                            player.color,

                        text:
                            text,

                        message:
                            text
                    }
                );
            }
        );


        /* =================================================
           VOICE
        ================================================= */

        socket.on(
            "voiceJoin",
            () => {

                const room =
                    findRoomByPlayer(
                        socket.id
                    );

                if (!room) {
                    return;
                }

                const peers =
                    room.players
                        .filter(
                            p =>
                                p.id !==
                                socket.id
                        )
                        .map(
                            p =>
                                p.id
                        );

                socket.emit(
                    "voicePeers",
                    peers
                );

                socket.to(
                    room.id
                ).emit(
                    "voiceUserJoined",
                    {
                        playerId:
                            socket.id
                    }
                );
            }
        );


        socket.on(
            "voiceSignal",
            data => {

                if (
                    !data ||
                    !data.to
                ) {
                    return;
                }

                io.to(
                    data.to
                ).emit(
                    "voiceSignal",
                    {
                        from:
                            socket.id,

                        data:
                            data.data ||
                            data.signal
                    }
                );
            }
        );


        /* =================================================
           LEAVE
        ================================================= */

        socket.on(
            "leaveRoom",
            () => {

                const room =
                    findRoomByPlayer(
                        socket.id
                    );

                if (!room) {
                    return;
                }

                rooms.delete(
                    room.id
                );

                io.to(
                    room.id
                ).emit(
                    "roomClosed",
                    "The room was closed."
                );

                socket.leave(
                    room.id
                );
            }
        );


        socket.on(
            "disconnect",
            () => {

                leaveQueue(
                    socket.id
                );

                removeSocketFromRoom(
                    socket.id
                );
            }
        );

    }
);


server.listen(
    PORT,
    () => {

        console.log(
            `Ludo Twist running on port ${PORT}`
        );

    }
);
