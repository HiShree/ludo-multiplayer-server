const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

let publicQueues = { 2: [], 3: [], 4: [] };
let activeRooms = {}; 

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('joinGame', (numPlayers) => {
        leaveAllQueues(socket.id);
        if (!publicQueues[numPlayers]) return;
        publicQueues[numPlayers].push(socket);

        if (publicQueues[numPlayers].length >= numPlayers) {
            let matchedSockets = publicQueues[numPlayers].splice(0, numPlayers);
            let roomId = 'pub_' + Math.random().toString(36).substring(2, 7);
            setupRoom(roomId, matchedSockets);
        } else {
            socket.emit('systemMessage', `Waiting for ${numPlayers - publicQueues[numPlayers].length} more players...`);
        }
    });

    socket.on('createPrivateGame', (numPlayers) => {
        leaveAllQueues(socket.id);
        let roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        activeRooms[roomCode] = {
            maxPlayers: numPlayers,
            sockets: [socket],
            isPrivate: true,
            started: false
        };

        socket.join(roomCode);
        socket.emit('privateRoomCreated', roomCode);
    });

    socket.on('joinPrivateGame', (code) => {
        let room = activeRooms[code];
        if (!room) { socket.emit('roomError', 'Room code not found!'); return; }
        if (room.started) { socket.emit('roomError', 'Game has already started!'); return; }
        if (room.sockets.length >= room.maxPlayers) { socket.emit('roomError', 'Room is full!'); return; }

        leaveAllQueues(socket.id);
        room.sockets.push(socket);
        socket.join(code);

        io.to(code).emit('systemMessage', `Player joined (${room.sockets.length}/${room.maxPlayers})...`);

        if (room.sockets.length === room.maxPlayers) {
            setupRoom(code, room.sockets);
        }
    });

    socket.on('sendChatMessage', (data) => {
        let roomId = getSocketRoom(socket);
        if (roomId) io.to(roomId).emit('receiveChatMessage', data);
    });

    socket.on('voiceData', (arrayBuffer) => {
        let roomId = getSocketRoom(socket);
        if (roomId) socket.to(roomId).emit('voiceData', arrayBuffer);
    });

    socket.on('requestRoll', (data) => {
        let roomId = getSocketRoom(socket);
        if (roomId) io.to(roomId).emit('executeRoll', data);
    });

    socket.on('requestMove', (data) => {
        let roomId = getSocketRoom(socket);
        if (roomId) io.to(roomId).emit('executeMove', data);
    });

    socket.on('syncState', (state) => {
        let roomId = getSocketRoom(socket);
        if (roomId) socket.to(roomId).emit('forceSync', state);
    });

    socket.on('disconnect', () => {
        leaveAllQueues(socket.id);
        console.log(`User disconnected: ${socket.id}`);
    });
});

function setupRoom(roomId, socketsArray) {
    let assignedIds = [0, 1, 2, 3].slice(0, socketsArray.length);
    socketsArray.forEach((sock, index) => {
        sock.room = roomId;
        sock.playerIndex = assignedIds[index];
        sock.emit('assignPlayer', sock.playerIndex);
    });
    if (activeRooms[roomId]) activeRooms[roomId].started = true;
    io.to(roomId).emit('gameStart', assignedIds);
    io.to(roomId).emit('systemMessage', 'Match started! Blue goes first.');
}

function leaveAllQueues(socketId) {
    for (let key in publicQueues) {
        publicQueues[key] = publicQueues[key].filter(s => s.id !== socketId);
    }
}

function getSocketRoom(socket) {
    for (let room of socket.rooms) {
        if (room !== socket.id) return room;
    }
    return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
