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

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Handle a player joining the game
    socket.on('joinGame', (requestedSize) => {
        let joinedRoom = null;
        
        for (let roomId in rooms) {
            let room = rooms[roomId];
            if (room.size === requestedSize && Object.keys(room.players).length < room.size) {
                joinedRoom = roomId;
                break;
            }
        }

        if (!joinedRoom) {
            joinedRoom = 'room_' + roomCounter++;
            let ids = [0, 1, 2, 3];
            if (requestedSize === 2) ids = [0, 2]; 
            if (requestedSize === 3) ids = [0, 1, 2]; 
            rooms[joinedRoom] = { size: requestedSize, players: {}, availableIds: ids };
        }

        const room = rooms[joinedRoom];
        const assignedId = room.availableIds.shift();
        room.players[socket.id] = assignedId;
        
        socket.join(joinedRoom);
        socket.roomId = joinedRoom;
        socket.colorId = assignedId;

        socket.emit('assignPlayer', assignedId);
        io.to(joinedRoom).emit('systemMessage', `Waiting for players... (${Object.keys(room.players).length}/${room.size})`);

        if (Object.keys(room.players).length === room.size) {
            let activeIds = Object.values(room.players);
            io.to(joinedRoom).emit('gameStart', activeIds);
            io.to(joinedRoom).emit('systemMessage', 'Game Started!');
        }
    });

    socket.on('requestRoll', (data) => {
        if (socket.roomId) io.to(socket.roomId).emit('executeRoll', data);
    });

    socket.on('requestMove', (data) => {
        if (socket.roomId) io.to(socket.roomId).emit('executeMove', data);
    });

    // --- NEW: Relay the Auto-Correction Sync data to out-of-sync phones ---
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
