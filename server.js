const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Store rooms and users
const rooms = new Map();
const users = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io
io.on('connection', (socket) => {
    console.log('👤 User connected:', socket.id);
    
    // Create room
    socket.on('create-room', (data) => {
        try {
            const { name, code } = data;
            const userName = name?.trim();
            
            if (!userName) {
                socket.emit('room-error', 'Please enter your name');
                return;
            }
            
            const roomCode = code || generateRoomCode();
            
            // Check if room exists
            if (rooms.has(roomCode)) {
                socket.emit('room-error', 'Room already exists');
                return;
            }
            
            // Create new room
            rooms.set(roomCode, {
                host: socket.id,
                hostName: userName,
                users: [{ 
                    id: socket.id, 
                    name: userName, 
                    isHost: true,
                    joinedAt: Date.now() 
                }],
                created: Date.now(),
                messages: [],
                settings: {
                    maxUsers: 50
                }
            });
            
            // Save user
            users.set(socket.id, {
                name: userName,
                room: roomCode,
                isHost: true
            });
            
            // Join room
            socket.join(roomCode);
            
            // Send success
            socket.emit('room-created', {
                code: roomCode,
                hostName: userName,
                users: rooms.get(roomCode).users
            });
            
            console.log(`✅ Room ${roomCode} created by ${userName}`);
            
        } catch (error) {
            console.error('Error creating room:', error);
            socket.emit('room-error', 'Error creating room');
        }
    });
    
    // Join room
    socket.on('join-room', (data) => {
        try {
            const { room, name } = data;
            const userName = name?.trim();
            const roomCode = room?.toUpperCase();
            
            if (!userName) {
                socket.emit('room-error', 'Please enter your name');
                return;
            }
            
            if (!roomCode || roomCode.length !== 6) {
                socket.emit('room-error', 'Invalid room code');
                return;
            }
            
            // Check if room exists
            if (!rooms.has(roomCode)) {
                socket.emit('room-error', 'Room not found');
                return;
            }
            
            const roomData = rooms.get(roomCode);
            
            // Check if user already in room
            const existingUser = roomData.users.find(u => u.id === socket.id);
            if (existingUser) {
                socket.emit('room-joined', {
                    room: roomCode,
                    hostName: roomData.hostName,
                    users: roomData.users,
                    messages: roomData.messages.slice(-100)
                });
                socket.join(roomCode);
                return;
            }
            
            // Check name uniqueness
            const nameExists = roomData.users.some(u => 
                u.name.toLowerCase() === userName.toLowerCase()
            );
            if (nameExists) {
                socket.emit('room-error', 'Name already taken');
                return;
            }
            
            // Add user to room
            const userObj = {
                id: socket.id,
                name: userName,
                isHost: false,
                joinedAt: Date.now()
            };
            
            roomData.users.push(userObj);
            
            // Save user
            users.set(socket.id, {
                name: userName,
                room: roomCode,
                isHost: false
            });
            
            // Join room
            socket.join(roomCode);
            
            // Send success to joiner
            socket.emit('room-joined', {
                room: roomCode,
                hostName: roomData.hostName,
                users: roomData.users,
                messages: roomData.messages.slice(-100)
            });
            
            // Notify everyone in room
            io.to(roomCode).emit('user-joined', {
                user: userObj,
                users: roomData.users
            });
            
            console.log(`✅ ${userName} joined room ${roomCode}`);
            
        } catch (error) {
            console.error('Error joining room:', error);
            socket.emit('room-error', 'Error joining room');
        }
    });
    
    // Send message
    socket.on('send-message', (data) => {
        try {
            const { room, message } = data;
            
            if (!room || !message || !message.text) return;
            
            const user = users.get(socket.id);
            if (!user) return;
            
            // Prepare message
            const fullMessage = {
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                sender: user.name,
                senderId: socket.id,
                text: message.text.trim(),
                time: new Date().toLocaleTimeString([], { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                }),
                timestamp: Date.now(),
                type: 'message'
            };
            
            // Store in room
            const roomData = rooms.get(room);
            if (roomData) {
                roomData.messages.push(fullMessage);
                // Keep last 200 messages only
                if (roomData.messages.length > 200) {
                    roomData.messages = roomData.messages.slice(-200);
                }
            }
            
            // Broadcast to room
            io.to(room).emit('receive-message', fullMessage);
            
            console.log(`💬 [${room}] ${user.name}: ${message.text}`);
            
        } catch (error) {
            console.error('Error sending message:', error);
        }
    });
    
    // Typing indicator
    socket.on('typing', (data) => {
        const { room, isTyping } = data;
        const user = users.get(socket.id);
        
        if (user) {
            socket.to(room).emit('user-typing', {
                name: user.name,
                isTyping: isTyping
            });
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        
        if (user) {
            const roomCode = user.room;
            const roomData = rooms.get(roomCode);
            
            if (roomData) {
                // Remove user
                const userIndex = roomData.users.findIndex(u => u.id === socket.id);
                if (userIndex !== -1) {
                    const userName = roomData.users[userIndex].name;
                    roomData.users.splice(userIndex, 1);
                    
                    // Notify others
                    socket.to(roomCode).emit('user-left', {
                        name: userName,
                        users: roomData.users
                    });
                    
                    console.log(`👋 ${userName} left room ${roomCode}`);
                    
                    // Delete empty room after 5 minutes
                    if (roomData.users.length === 0) {
                        setTimeout(() => {
                            if (rooms.has(roomCode) && rooms.get(roomCode).users.length === 0) {
                                rooms.delete(roomCode);
                                console.log(`🗑️ Room ${roomCode} deleted`);
                            }
                        }, 5 * 60 * 1000);
                    }
                }
            }
            
            // Remove user
            users.delete(socket.id);
        }
        
        console.log('❌ User disconnected:', socket.id);
    });
});

// Generate room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('👥 Group chat ready for 3+ friends!');
});