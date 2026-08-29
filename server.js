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

const activeRooms = {};

// --------------------------------------------------
// CONNECTION
// --------------------------------------------------

io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    // --------------------------------------------------
    // PUBLIC GAME
    // --------------------------------------------------

    socket.on("joinGame", (numPlayers) => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit("roomError", "Invalid player count.");
            return;
        }

        leaveAllQueues(socket.id);

        publicQueues[numPlayers].push(socket);

        const waiting = publicQueues[numPlayers].length;

        if (waiting >= numPlayers) {

            const matchedSockets =
                publicQueues[numPlayers].splice(0, numPlayers);

            const roomId =
                "pub_" + Math.random().toString(36).substring(2, 9);

            setupRoom(roomId, matchedSockets);

        } else {

            socket.emit(
                "systemMessage",
                `Waiting for ${numPlayers - waiting} more player(s)...`
            );
        }
    });

    // --------------------------------------------------
    // CREATE PRIVATE ROOM
    // --------------------------------------------------

    socket.on("createPrivateGame", (numPlayers) => {

        numPlayers = Number(numPlayers);

        if (![2, 3, 4].includes(numPlayers)) {
            socket.emit("roomError", "Invalid player count.");
            return;
        }

        leaveAllQueues(socket.id);

        const roomCode =
            Math.random().toString(36).substring(2, 8).toUpperCase();

        activeRooms[roomCode] = {
            maxPlayers: numPlayers,
            sockets: [socket],
            started: false,
            createdAt: Date.now()
        };

        socket.join(roomCode);

        socket.room = roomCode;

        socket.emit("privateRoomCreated", roomCode);

        socket.emit(
            "systemMessage",
            `Room created. Code: ${roomCode}`
        );
    });

    // --------------------------------------------------
    // JOIN PRIVATE ROOM
    // --------------------------------------------------

    socket.on("joinPrivateGame", (rawCode) => {

        const code =
            String(rawCode || "").trim().toUpperCase();

        const room = activeRooms[code];

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

        room.sockets.push(socket);

        socket.join(code);
        socket.room = code;

        io.to(code).emit(
            "systemMessage",
            `Player joined (${room.sockets.length}/${room.maxPlayers})...`
        );

        if (room.sockets.length === room.maxPlayers) {
            setupRoom(code, room.sockets);
        }
    });

    // --------------------------------------------------
    // CHAT
    // --------------------------------------------------

    socket.on("sendChatMessage", (data) => {

        const roomId = getSocketRoom(socket);

        if (!roomId) return;

        if (!data || typeof data.text !== "string") return;

        const text = data.text.trim();

        if (!text) return;

        io.to(roomId).emit(
            "receiveChatMessage",
            {
                name: String(data.name || "Player").substring(0, 30),
                text: text.substring(0, 300)
            }
        );
    });

    // --------------------------------------------------
    // VOICE
    // --------------------------------------------------

    socket.on("voiceData", (audioData) => {

        const roomId = getSocketRoom(socket);

        if (!roomId) return;

        socket.to(roomId).emit(
            "voiceData",
            audioData
        );
    });

    // --------------------------------------------------
    // ROLL
    // --------------------------------------------------

    socket.on("requestRoll", (data) => {

        const roomId = getSocketRoom(socket);

        if (!roomId) return;

        if (!data) return;

        if (Number(data.playerId) !== Number(socket.playerIndex)) {
            return;
        }

        io.to(roomId).emit(
            "executeRoll",
            {
                playerId: Number(data.playerId),
                rollValue: Number(data.rollValue)
            }
        );
    });

    // --------------------------------------------------
    // MOVE
    // --------------------------------------------------

    socket.on("requestMove", (data) => {

        const roomId = getSocketRoom(socket);

        if (!roomId) return;

        if (!data) return;

        if (Number(data.playerId) !== Number(socket.playerIndex)) {
            return;
        }

        io.to(roomId).emit(
            "executeMove",
            {
                playerId: Number(data.playerId),
                pawnIndex: Number(data.pawnIndex)
            }
        );
    });

    // --------------------------------------------------
    // STATE SYNC
    // --------------------------------------------------

    socket.on("syncState", (state) => {

        const roomId = getSocketRoom(socket);

        if (!roomId) return;

        if (!state) return;

        socket.to(roomId).emit(
            "forceSync",
            state
        );
    });

    // --------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------

    socket.on("disconnect", () => {

        leaveAllQueues(socket.id);

        const roomId = socket.room;

        if (roomId && activeRooms[roomId]) {

            const room = activeRooms[roomId];

            room.sockets =
                room.sockets.filter(
                    s => s.id !== socket.id
                );

            if (room.sockets.length === 0) {
                delete activeRooms[roomId];
            }
        }

        console.log("Disconnected:", socket.id);
    });
});


// --------------------------------------------------
// SETUP ROOM
// --------------------------------------------------

function setupRoom(roomId, socketsArray) {

    const assignedIds =
        [0, 1, 2, 3].slice(0, socketsArray.length);

    socketsArray.forEach((sock, index) => {

        sock.room = roomId;
        sock.playerIndex = assignedIds[index];

        sock.emit(
            "assignPlayer",
            assignedIds[index]
        );
    });

    if (activeRooms[roomId]) {
        activeRooms[roomId].started = true;
    }

    io.to(roomId).emit(
        "gameStart",
        assignedIds
    );

    io.to(roomId).emit(
        "systemMessage",
        "Match started! Blue goes first."
    );
}


// --------------------------------------------------
// REMOVE SOCKET FROM PUBLIC QUEUES
// --------------------------------------------------

function leaveAllQueues(socketId) {

    for (const key in publicQueues) {

        publicQueues[key] =
            publicQueues[key].filter(
                socket => socket.id !== socketId
            );
    }
}


// --------------------------------------------------
// GET SOCKET ROOM
// --------------------------------------------------

function getSocketRoom(socket) {

    if (socket.room) {
        return socket.room;
    }

    for (const room of socket.rooms) {

        if (room !== socket.id) {
            return room;
        }
    }

    return null;
}


// --------------------------------------------------
// SERVER
// --------------------------------------------------

const PORT =
    process.env.PORT || 3000;

server.listen(PORT, () => {

    console.log(
        `Ludo Twist server running on port ${PORT}`
    );
});
