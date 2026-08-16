const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the game files
app.use(express.static(__dirname));

let rooms = {};
let roomCounter = 1;

// Function to generate a random 6-character room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // --- PUBLIC MATCHMAKING ---
    socket.on('joinGame', (requestedSize) => {
        let joinedRoom = null;
        
        for (let roomId in rooms) {
            let room = rooms[roomId];
            if (!room.isPrivate && room.size === requestedSize && Object.keys(room.players).length < room.size) {
                joinedRoom = roomId;
                break;
            }
        }

        if (!joinedRoom) {
            joinedRoom = 'room_' + roomCounter++;
            let ids = [0, 1, 2, 3];
            if (requestedSize === 2) ids = [0, 2]; 
            if (requestedSize === 3) ids = [0, 1, 2]; 
            rooms[joinedRoom] = { size: requestedSize, players: {}, availableIds: ids, isPrivate: false };
        }

        const room = rooms[joinedRoom];
        const assignedId = room.availableIds.shift();
        room.players[socket.id] = assignedId;
        
        socket.join(joinedRoom);
        socket.roomId = joinedRoom;
        socket.colorId = assignedId;

        socket.emit('assignPlayer', assignedId);
        io.to(joinedRoom).emit('systemMessage', `Waiting for public players... (${Object.keys(room.players).length}/${room.size})`);

        if (Object.keys(room.players).length === room.size) {
            let activeIds = Object.values(room.players);
            io.to(joinedRoom).emit('gameStart', activeIds);
            io.to(joinedRoom).emit('systemMessage', 'Game Started!');
        }
    });

    // --- PRIVATE ROOM: CREATE ---
    socket.on('createPrivateGame', (requestedSize) => {
        const roomCode = generateRoomCode();
        let ids = [0, 1, 2, 3];
        if (requestedSize === 2) ids = [0, 2]; 
        if (requestedSize === 3) ids = [0, 1, 2]; 

        rooms[roomCode] = { size: requestedSize, players: {}, availableIds: ids, isPrivate: true };

        const assignedId = rooms[roomCode].availableIds.shift();
        rooms[roomCode].players[socket.id] = assignedId;

        socket.join(roomCode);
        socket.roomId = roomCode;
        socket.colorId = assignedId;

        socket.emit('assignPlayer', assignedId);
        socket.emit('privateRoomCreated', roomCode);
        io.to(roomCode).emit('systemMessage', `Room Code: ${roomCode} (Waiting: ${Object.keys(rooms[roomCode].players).length}/${requestedSize})`);
    });

    // --- PRIVATE ROOM: JOIN ---
    socket.on('joinPrivateGame', (roomCode) => {
        roomCode = roomCode.toUpperCase();
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('roomError', 'Room not found! Check your code.');
            return;
        }
        if (Object.keys(room.players).length >= room.size) {
            socket.emit('roomError', 'This room is already full!');
            return;
        }

        const assignedId = room.availableIds.shift();
        room.players[socket.id] = assignedId;

        socket.join(roomCode);
        socket.roomId = roomCode;
        socket.colorId = assignedId;

        socket.emit('assignPlayer', assignedId);
        io.to(roomCode).emit('systemMessage', `Room Code: ${roomCode} (Waiting: ${Object.keys(room.players).length}/${room.size})`);

        if (Object.keys(room.players).length === room.size) {
            let activeIds = Object.values(room.players);
            io.to(roomCode).emit('gameStart', activeIds);
            io.to(roomCode).emit('systemMessage', 'Game Started!');
        }
    });

    // --- GAMEPLAY RELAYS ---
    socket.on('requestRoll', (data) => {
        if (socket.roomId) io.to(socket.roomId).emit('executeRoll', data);
    });

    socket.on('requestMove', (data) => {
        if (socket.roomId) io.to(socket.roomId).emit('executeMove', data);
    });

    socket.on('syncState', (state) => {
        if (socket.roomId) socket.to(socket.roomId).emit('forceSync', state);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            delete room.players[socket.id];
            
            room.availableIds.push(socket.colorId);
            room.availableIds.sort();
            
            io.to(socket.roomId).emit('systemMessage', `A player disconnected.`);
            
            if (Object.keys(room.players).length === 0) {
                delete rooms[socket.roomId];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Multiplayer server running on port ${PORT}`);
});
