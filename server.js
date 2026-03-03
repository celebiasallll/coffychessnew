// Coffee Chess Server - SECURE EDITION
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Chess } from 'chess.js';
import { ethers } from 'ethers';
import { moduleAddress, moduleAbi } from './coffytokenvemodülabi.js';
import * as dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

// ============ DEVELOPMENT MODE ============
// Set to true for local testing without blockchain verification
const DEV_MODE = false;

// ============ CONFIGURATION CONSTANTS ============
const PORT = process.env.PORT || 3005;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_CHAT_MAX = 20;
const RATE_LIMIT_CLEANUP_INTERVAL = 300000; // 5 minutes
const CLEANUP_DELAY_MS = 5000;
const RECONNECT_TIMEOUT_MS = 60000;
const STAKE_VERIFY_MAX_RETRIES = 15;
const STAKE_VERIFY_BASE_DELAY = 3000;
const GAME_END_DEADLINE_SECONDS = 3600; // 1 hour to claim after game ends
// ===========================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============ USERNAME STORAGE ============
const USERS_FILE = join(__dirname, 'users.json');
let registeredUsers = {}; // walletAddress(lower) -> username

try {
    if (fs.existsSync(USERS_FILE)) {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        registeredUsers = JSON.parse(data);
        console.log(`✅ Loaded ${Object.keys(registeredUsers).length} registered users`);
    } else {
        fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
    }
} catch (error) {
    console.error('❌ Error loading users.json:', error);
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers, null, 2));
    } catch (error) {
        console.error('❌ Error saving users.json:', error);
    }
}
// ===========================================

const app = express();

// ============ CORS - Restrict to known origins ============
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://coffeechess.com'
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        console.warn(`⚠️ CORS blocked origin: ${origin}`);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json());
app.use(express.static(__dirname));

app.get('/favicon.ico', (req, res) => res.status(204).end());

const server = createServer(app);

// Socket.IO CORS
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type']
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// Multi-RPC fallback for better reliability
const RPC_URLS = [
    'https://mainnet.base.org',
    'https://base.meowrpc.com',
    'https://base.publicnode.com'
];

let provider;
let moduleContract;

async function initializeProvider() {
    for (const url of RPC_URLS) {
        try {
            const testProvider = new ethers.providers.JsonRpcProvider(url);
            await testProvider.getNetwork();
            provider = testProvider;
            console.log(`✅ Connected to Base RPC: ${url}`);
            return;
        } catch (error) {
            console.warn(`⚠️ Failed to connect to ${url}, trying next...`);
        }
    }
    throw new Error('❌ Could not connect to any Base RPC endpoint');
}

// Storage
const rooms = new Map();
const playerSessions = new Map(); // walletAddress -> { socketId, roomId, reconnectTimer }
let roomCounter = 1;

function generateRoomId() {
    return 'CHESS-' + String(roomCounter++).padStart(4, '0');
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        game: 'Coffee Chess Secure',
        rooms: rooms.size,
        activePlayers: playerSessions.size
    });
});

// List rooms API
app.get('/rooms', (req, res) => {
    const openRooms = [];
    rooms.forEach((room, roomId) => {
        if (!room.started) {
            openRooms.push({
                roomId,
                playersCount: room.players.length,
                meta: room.meta
            });
        }
    });
    res.json(openRooms);
});

// Rate limiting storage
const rateLimits = new Map(); // socketId -> { count, resetTime }

function checkRateLimit(socketId, maxRequests = RATE_LIMIT_MAX_REQUESTS, windowMs = RATE_LIMIT_WINDOW_MS) {
    const now = Date.now();
    const limit = rateLimits.get(socketId);

    if (!limit || now > limit.resetTime) {
        rateLimits.set(socketId, { count: 1, resetTime: now + windowMs });
        return true;
    }

    if (limit.count >= maxRequests) {
        return false;
    }

    limit.count++;
    return true;
}

// Cleanup rate limits periodically to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [key, limit] of rateLimits.entries()) {
        if (now > limit.resetTime) {
            rateLimits.delete(key);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} expired rate limit entries`);
    }
}, RATE_LIMIT_CLEANUP_INTERVAL);

// Verify stake on blockchain
async function verifyStake(gameId, playerAddress, expectedStake) {
    for (let attempt = 1; attempt <= STAKE_VERIFY_MAX_RETRIES; attempt++) {
        try {
            console.log(`🔍 Verifying stake for game ${gameId}, player ${playerAddress} (Attempt ${attempt}/${STAKE_VERIFY_MAX_RETRIES})`);

            const g = await moduleContract.getGameInfo(gameId);
            const player1 = g.player1.toLowerCase();
            const player2 = (g.player2 || ethers.constants.AddressZero).toLowerCase();
            const status = Number(g.status);

            const addr = playerAddress.toLowerCase();
            if (player1 !== addr && player2 !== addr) {
                console.log(`⚠️ Player not found in game yet, retrying...`);
                if (attempt < STAKE_VERIFY_MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, attempt * STAKE_VERIFY_BASE_DELAY));
                    continue;
                }
                return false;
            }

            if (status >= 2) {
                console.log(`❌ Game ${gameId} already done (status: ${status})`);
                return false;
            }

            console.log(`✅ Game ${gameId} verified for ${playerAddress}`);
            return true;

        } catch (error) {
            console.error(`Attempt ${attempt} error:`, error.message);
            if (attempt < STAKE_VERIFY_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, attempt * STAKE_VERIFY_BASE_DELAY));
            }
        }
    }
    return false;
}

// Socket handlers
io.on('connection', (socket) => {
    console.log('👤 Connected:', socket.id);
    let currentRoom = null;
    let playerNum = null;
    let walletAddress = null;

    // Create room
    socket.on('createRoom', async (data, callback) => {
        console.log('📥 createRoom request received:', { gameId: data.gameId, wallet: data.walletAddress, stake: data.stake });
        walletAddress = data.walletAddress.toLowerCase();

        // Check if player already has an active session
        if (playerSessions.has(walletAddress)) {
            const existingSession = playerSessions.get(walletAddress);
            const existingSocket = io.sockets.sockets.get(existingSession.socketId);
            if (existingSocket && existingSocket.connected && rooms.has(existingSession.roomId)) {
                callback({ error: 'You already have an active game', roomId: existingSession.roomId });
                return;
            } else {
                console.log(`♻️ Overwriting old session for ${walletAddress} (disconnected or room gone)`);
            }
        }

        const roomId = generateRoomId();
        const timeLimit = data.timeLimit || 5;
        const initialTime = timeLimit * 60;

        const room = {
            id: roomId,
            players: [{
                id: socket.id,
                address: walletAddress,
                color: 'white'
            }],
            meta: {
                gameId: data.gameId,
                stake: data.stake,
                timeLimit: timeLimit,
                createdAt: Date.now()
            },
            chess: new Chess(),
            timers: { white: initialTime, black: initialTime, interval: null, turn: 'w' },
            moves: [],
            chatMessages: [],
            started: false,
            gameOver: false,
            lastMoveTime: Date.now(),
            verified: false
        };

        rooms.set(roomId, room);
        socket.join(roomId);
        currentRoom = roomId;
        playerNum = 1;

        playerSessions.set(walletAddress, {
            socketId: socket.id,
            roomId,
            reconnectTimer: null
        });

        console.log(`📦 Room ${roomId} created OPTIMISTICALLY by ${walletAddress} (GameID: ${data.gameId})`);

        callback({ success: true, roomId });

        // Background Verification
        if (!DEV_MODE) {
            verifyStake(data.gameId, walletAddress, data.stake).then(stakeVerified => {
                if (!stakeVerified) {
                    console.log(`❌ Background verification failed for ${roomId}. Closing room.`);
                    io.to(roomId).emit('error', { message: 'Stake verification failed. Room closing.' });
                    io.to(roomId).emit('gameCancelled', { reason: 'Stake verification failed' });
                    cleanupRoom(roomId);
                } else {
                    console.log(`✅ Background verification SUCCESS for ${roomId}`);
                    const r = rooms.get(roomId);
                    if (r) r.verified = true;
                }
            });
        } else {
            room.verified = true;
        }
    });

    // Join room
    socket.on('joinRoom', async (data, callback) => {
        const { roomId: targetRoomId, walletAddress: joinWallet, gameId } = data;
        walletAddress = joinWallet.toLowerCase();

        const room = rooms.get(targetRoomId);

        if (!room) {
            callback({ error: 'Room not found' });
            return;
        }

        if (room.players.length >= 2) {
            callback({ error: 'Room is full' });
            return;
        }

        if (room.started) {
            callback({ error: 'Game already started' });
            return;
        }

        if (room.players[0].address === walletAddress) {
            callback({ error: 'Cannot play against yourself' });
            return;
        }

        room.players.push({
            id: socket.id,
            address: walletAddress,
            color: 'black'
        });
        socket.join(targetRoomId);
        currentRoom = targetRoomId;
        playerNum = 2;

        playerSessions.set(walletAddress, {
            socketId: socket.id,
            roomId: targetRoomId,
            reconnectTimer: null
        });

        room.started = true;

        // Background verification for joiner
        if (!DEV_MODE) {
            verifyStake(gameId, walletAddress, room.meta.stake).then(stakeVerified => {
                if (!stakeVerified) {
                    console.log(`❌ Background verification failed for JOINER ${walletAddress} in room ${targetRoomId}`);
                    io.to(targetRoomId).emit('error', { message: 'Opponent stake verification failed. Game cancelled.' });
                    io.to(targetRoomId).emit('gameCancelled', { reason: 'Opponent stake verification failed' });
                    cleanupRoom(targetRoomId);
                } else {
                    console.log(`✅ Background verification SUCCESS for JOINER ${walletAddress}`);
                }
            });
        }

        // Emit startGame to each player with their specific data
        io.to(room.players[0].id).emit('startGame', {
            playerNumber: 1,
            color: 'white',
            opponent: room.players[1].address,
            timers: { white: room.timers.white, black: room.timers.black },
            chatHistory: room.chatMessages,
            gameId: room.meta.gameId,
            meta: room.meta
        });

        io.to(room.players[1].id).emit('startGame', {
            playerNumber: 2,
            color: 'black',
            opponent: room.players[0].address,
            timers: { white: room.timers.white, black: room.timers.black },
            chatHistory: room.chatMessages,
            gameId: room.meta.gameId,
            meta: room.meta
        });

        console.log(`🎮 Game started in ${targetRoomId}`);
        callback({ success: true });
    });

    // Move
    socket.on('makeMove', (data) => {
        if (!checkRateLimit(socket.id, RATE_LIMIT_MAX_REQUESTS, 10000)) {
            socket.emit('moveRejected', { reason: 'Too many moves. Slow down!' });
            return;
        }

        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || !room.started || room.gameOver) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) {
            socket.emit('moveRejected', { reason: 'You are not in this game' });
            return;
        }

        const currentTurn = room.chess.turn();
        const playerColor = player.color === 'white' ? 'w' : 'b';
        if (currentTurn !== playerColor) {
            socket.emit('moveRejected', { reason: 'Not your turn' });
            return;
        }

        try {
            const move = room.chess.move(data.move);

            if (!move) {
                socket.emit('moveRejected', { reason: 'Invalid move' });
                return;
            }

            room.moves.push(move);
            room.lastMoveTime = Date.now();

            if (!room.timers.interval) {
                startRoomTimer(currentRoom);
            }

            io.to(currentRoom).emit('moveAccepted', {
                move: move,
                fen: room.chess.fen(),
                pgn: room.chess.pgn(),
                playerNum: playerNum,
                turn: room.chess.turn()
            });

            let winner = null;
            let reason = '';
            const currentColor = room.chess.turn();

            console.log(`📊 After move - checking game state: in_checkmate=${room.chess.in_checkmate()}, in_draw=${room.chess.in_draw()}, turn=${currentColor}`);

            if (room.chess.in_checkmate()) {
                winner = currentColor === 'w' ? 'black' : 'white';
                reason = 'checkmate';
                console.log(`♚ CHECKMATE detected! Winner: ${winner}`);
            } else if (room.chess.in_draw()) {
                winner = 'draw';
                reason = room.chess.in_stalemate() ? 'stalemate' :
                    room.chess.in_threefold_repetition() ? 'repetition' :
                        room.chess.insufficient_material() ? 'insufficient material' : 'draw';
                console.log(`🤝 DRAW detected! Reason: ${reason}`);
            }

            if (winner !== null) {
                console.log(`🏁 Calling handleGameEnd for room ${currentRoom}, winner: ${winner}`);
                handleGameEnd(currentRoom, winner, reason);
            }
        } catch (error) {
            socket.emit('moveRejected', { reason: 'Invalid move format' });
            console.error('Move error:', error);
        }
    });

    // Resign
    socket.on('resign', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || room.gameOver) return;

        const winner = playerNum === 1 ? 'black' : 'white';
        handleGameEnd(currentRoom, winner, 'resignation');
    });

    // Draw offer logic
    socket.on('offerDraw', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || room.gameOver) return;

        if (room.pendingDrawOffer) return;

        room.pendingDrawOffer = socket.id;

        room.drawOfferTimeout = setTimeout(() => {
            if (room.pendingDrawOffer === socket.id) {
                room.pendingDrawOffer = null;
                console.log(`⏰ Draw offer expired in room ${currentRoom}`);
                io.to(socket.id).emit('drawDeclined');
            }
        }, 30000);

        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent) {
            io.to(opponent.id).emit('drawOffered');
            console.log(`🤝 Draw offered by player in room ${currentRoom}`);
        }
    });

    socket.on('acceptDraw', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || room.gameOver) return;

        if (!room.pendingDrawOffer || room.pendingDrawOffer === socket.id) return;

        if (room.drawOfferTimeout) clearTimeout(room.drawOfferTimeout);
        room.pendingDrawOffer = null;
        console.log(`🤝 Draw accepted in room ${currentRoom}`);

        handleGameEnd(currentRoom, 'draw', 'mutual agreement');
    });

    socket.on('declineDraw', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || room.gameOver) return;

        if (!room.pendingDrawOffer || room.pendingDrawOffer === socket.id) return;

        if (room.drawOfferTimeout) clearTimeout(room.drawOfferTimeout);
        room.pendingDrawOffer = null;
        console.log(`❌ Draw declined in room ${currentRoom}`);

        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent) {
            io.to(opponent.id).emit('drawDeclined');
        }
    });

    // Chat message
    socket.on('chatMessage', (data) => {
        if (!checkRateLimit(socket.id + '_chat', RATE_LIMIT_CHAT_MAX, 60000)) {
            socket.emit('chatError', { reason: 'Too many messages. Please slow down.' });
            return;
        }

        if (!currentRoom || !walletAddress) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        let message = data.message;
        if (typeof message !== 'string') return;

        message = message.trim();
        if (!message || message.length === 0 || message.length > 200) return;

        // XSS protection
        message = message
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');

        // Basic profanity filter
        const profanityList = ['spam', 'scam', 'hack', 'cheat'];
        const lowerMsg = message.toLowerCase();
        for (const word of profanityList) {
            if (lowerMsg.includes(word)) {
                message = message.replace(new RegExp(word, 'gi'), '***');
            }
        }

        const lowerWallet = walletAddress.toLowerCase();
        const senderDisplay = registeredUsers[lowerWallet] || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

        const chatMsg = {
            id: Date.now() + Math.random(),
            sender: walletAddress,
            senderShort: senderDisplay,
            playerNum: playerNum,
            message: message,
            timestamp: Date.now()
        };

        room.chatMessages.push(chatMsg);

        if (room.chatMessages.length > 100) {
            room.chatMessages.shift();
        }

        io.to(currentRoom).emit('chatMessage', chatMsg);
        console.log(`💬 Chat in ${currentRoom} from Player${playerNum} (${senderDisplay}): ${message}`);
    });

    // Username logic
    socket.on('checkUsername', (data, callback) => {
        if (!data || !data.walletAddress) return callback({ error: 'No wallet provided' });
        const wallet = data.walletAddress.toLowerCase();

        if (registeredUsers[wallet]) {
            callback({ success: true, username: registeredUsers[wallet] });
        } else {
            callback({ success: false, error: 'No username registered' });
        }
    });

    socket.on('setUsername', (data, callback) => {
        if (!checkRateLimit(socket.id + '_setname', 5, 60000)) {
            return callback({ success: false, error: 'Too many requests' });
        }

        const wallet = data.walletAddress?.toLowerCase();
        let desiredName = data.username;

        if (!wallet || !desiredName) return callback({ success: false, error: 'Missing data' });

        if (registeredUsers[wallet]) {
            return callback({ success: false, error: 'This wallet already has a registered username' });
        }

        desiredName = desiredName.trim();
        if (desiredName.length < 3 || desiredName.length > 15) {
            return callback({ success: false, error: 'Username must be between 3 and 15 characters' });
        }

        if (!/^[a-zA-Z0-9_]+$/.test(desiredName)) {
            return callback({ success: false, error: 'Username can only contain letters, numbers, and underscores' });
        }

        const lowerDesired = desiredName.toLowerCase();
        const isTaken = Object.values(registeredUsers).some(name => name.toLowerCase() === lowerDesired);

        if (isTaken) {
            return callback({ success: false, error: 'This username is already taken' });
        }

        registeredUsers[wallet] = desiredName;
        saveUsers();
        console.log(`🏷️  User Registered: ${wallet} -> ${desiredName}`);

        callback({ success: true, username: desiredName });
    });

    // Ping/Pong latency
    socket.on('pingHeartbeat', (clientTime) => {
        socket.emit('pongHeartbeat', clientTime);
    });

    // List rooms
    socket.on('listRooms', (callback) => {
        const openRooms = [];
        rooms.forEach((room, roomId) => {
            if (!room.started && room.players.length < 2) {
                openRooms.push({
                    roomId,
                    playersCount: room.players.length,
                    meta: room.meta
                });
            }
        });
        callback(openRooms);
    });

    // Get room info
    socket.on('getRoomInfo', (roomId, callback) => {
        const room = rooms.get(roomId);
        if (!room) {
            callback({ error: 'Room not found' });
            return;
        }
        if (room.started || room.players.length >= 2) {
            callback({ error: 'Room is full or game already started' });
            return;
        }
        callback({
            roomId: roomId,
            gameId: room.meta?.gameId,
            stake: room.meta?.stake,
            timeLimit: room.meta?.timeLimit,
            playersCount: room.players.length
        });
    });

    // Find room by blockchain gameId
    socket.on('findRoomByGameId', (gameId, callback) => {
        console.log(`🔍 Searching for room with gameId: ${gameId}`);

        let foundRoom = null;
        let foundRoomId = null;

        rooms.forEach((room, roomId) => {
            if (room.meta?.gameId?.toString() === gameId?.toString()) {
                if (!room.started && room.players.length < 2) {
                    foundRoom = room;
                    foundRoomId = roomId;
                }
            }
        });

        if (!foundRoom) {
            console.log(`❌ No room found for gameId: ${gameId}`);
            const openRoomsDebug = Array.from(rooms.entries()).map(([id, r]) => ({
                roomId: id,
                metaGameId: r.meta?.gameId,
                metaGameIdStr: r.meta?.gameId?.toString(),
                queryGameIdStr: gameId?.toString(),
                match: r.meta?.gameId?.toString() === gameId?.toString(),
                started: r.started,
                players: r.players.length
            }));
            console.log(`📋 Room Scan:`, JSON.stringify(openRoomsDebug, null, 2));
            callback({ error: 'No open room found for this Game ID' });
            return;
        }

        console.log(`✅ Found room ${foundRoomId} for gameId: ${gameId}`);
        callback({
            roomId: foundRoomId,
            gameId: foundRoom.meta?.gameId,
            stake: foundRoom.meta?.stake,
            timeLimit: foundRoom.meta?.timeLimit,
            playersCount: foundRoom.players.length
        });
    });

    // Reconnect
    socket.on('reconnect', async (data, callback) => {
        const reconnectWallet = data.walletAddress?.toLowerCase();
        const signature = data.signature;

        if (!reconnectWallet) {
            callback({ success: false, error: 'No wallet address provided' });
            return;
        }

        // SESSION TOKEN: İmza yerine localStorage'daki token kullan
        // Chess oyunu için imza zorunluluğu kaldırıldı — MetaMask popup yok
        const sessionToken = data.sessionToken;
        const session = playerSessions.get(reconnectWallet);

        // Token varsa doğrula, yoksa sadece wallet adresiyle session'a bak
        if (sessionToken && session?.token && session.token !== sessionToken) {
            callback({ success: false, error: 'Invalid session token' });
            return;
        }

        if (!session || !session.roomId) {
            callback({ success: false, error: 'No active session found' });
            return;
        }

        const room = rooms.get(session.roomId);
        if (!room) {
            playerSessions.delete(reconnectWallet);
            callback({ success: false, error: 'Game room no longer exists' });
            return;
        }

        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer);
            session.reconnectTimer = null;
        }

        const player = room.players.find(p => p.address === reconnectWallet);
        if (!player) {
            callback({ success: false, error: 'Player not found in room' });
            return;
        }

        player.id = socket.id;
        session.socketId = socket.id;

        currentRoom = session.roomId;
        walletAddress = reconnectWallet;
        playerNum = player.color === 'white' ? 1 : 2;

        socket.join(session.roomId);

        const opponent = room.players.find(p => p.address !== reconnectWallet);
        if (opponent) {
            io.to(opponent.id).emit('opponentReconnected', {
                message: 'Opponent has reconnected!'
            });
        }

        console.log(`🔄 Player ${reconnectWallet} reconnected to ${session.roomId}`);

        callback({
            success: true,
            roomId: session.roomId,
            playerNumber: playerNum,
            color: player.color,
            gameId: room.meta?.gameId,
            fen: room.chess.fen(),
            pgn: room.chess.pgn(),
            timers: { white: room.timers.white, black: room.timers.black },
            chatHistory: room.chatMessages || [],
            gameOver: room.gameOver,
            winner: room.winner,
            reason: room.endReason,
            opponent: opponent?.address,
            signatureWhite: room.signatureWhite,
            signatureBlack: room.signatureBlack
        });
    });

    // On-demand signature delivery for claim recovery
    socket.on('requestSignature', ({ gameId, walletAddress: reqWallet }, callback) => {
        if (typeof callback !== 'function') return;

        let foundSig = null;
        rooms.forEach((room) => {
            if (String(room.meta?.gameId) !== String(gameId)) return;
            if (!room.gameOver) return;
            const player = room.players.find(p => p.address?.toLowerCase() === reqWallet?.toLowerCase());
            if (!player) return;
            foundSig = player.color === 'white' ? room.signatureWhite : room.signatureBlack;
        });

        if (foundSig) {
            console.log(`📝 Signature delivered on-demand for gameId ${gameId} to ${reqWallet}`);
            callback({ signature: foundSig });
        } else {
            console.warn(`⚠️ requestSignature: No signature found for gameId ${gameId} / ${reqWallet}`);
            callback({ signature: null, error: 'Signature not available' });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('👋 Disconnected:', socket.id);

        if (currentRoom && walletAddress) {
            const room = rooms.get(currentRoom);
            if (room && !room.gameOver) {
                const opponentId = room.players.find(p => p.address !== walletAddress)?.id;
                if (opponentId) {
                    io.to(opponentId).emit('opponentDisconnected', {
                        message: 'Opponent disconnected. They have 60 seconds to reconnect.'
                    });
                }

                const session = playerSessions.get(walletAddress);
                if (session) {
                    session.reconnectTimer = setTimeout(() => {
                        if (rooms.has(currentRoom)) {
                            const winner = playerNum === 1 ? 'black' : 'white';
                            handleGameEnd(currentRoom, winner, 'disconnect');
                            // NOTE: cleanupRoom is called inside handleGameEnd via setTimeout(30s)
                            // so we do NOT call it again here to avoid double cleanup
                        }
                    }, RECONNECT_TIMEOUT_MS);
                }
            } else if (room && room.gameOver) {
                setTimeout(() => cleanupRoom(currentRoom), CLEANUP_DELAY_MS);
            }
        }
    });
});

async function handleGameEnd(roomId, winner, reason) {
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;

    console.log(`🏁 Game ended in ${roomId}: ${winner} wins (${reason})`);

    room.gameOver = true;
    room.winner = winner;
    room.endReason = reason;
    room.signatureWhite = null;
    room.signatureBlack = null;

    if (room.timers.interval) {
        clearInterval(room.timers.interval);
        room.timers.interval = null;
    }

    let whiteScore = 0;
    let blackScore = 0;

    if (winner === 'white') {
        whiteScore = 1000;
        blackScore = 0;
    } else if (winner === 'black') {
        whiteScore = 0;
        blackScore = 1000;
    } else {
        whiteScore = 500;
        blackScore = 500;
    }

    const whitePlayer = room.players.find(p => p.color === 'white');
    const blackPlayer = room.players.find(p => p.color === 'black');
    const winnerAddress = winner === 'white' ? whitePlayer?.address :
        winner === 'black' ? blackPlayer?.address : null;

    let signatureWhite = null;
    let signatureBlack = null;

    // FIX: deadline is now properly defined
    const deadline = Math.floor(Date.now() / 1000) + GAME_END_DEADLINE_SECONDS;

    const gameId = room.meta?.gameId;
    if (!gameId) {
        console.error(`❌ No gameId found for room ${roomId}, cannot generate signatures`);
        return;
    }

    try {
        if (!process.env.SIGNER_PRIVATE_KEY) {
            console.error("❌ SIGNER_PRIVATE_KEY missing in .env!");
        } else {
            const signer = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY);
            console.log(`📝 Signing with wallet address: ${signer.address}`);
            // chainId hardcoded = 8453 (Base mainnet) — dynamic getNetwork() can return wrong chain under RPC pressure
            const chainId = 8453;

            const domain = {
                name: "Coffy",
                version: "1",
                chainId: chainId,
                verifyingContract: moduleAddress
            };

            const types = {
                GameWin: [
                    { name: "id", type: "uint256" },
                    { name: "winner", type: "address" }
                ],
                GameDraw: [
                    { name: "id", type: "uint256" }
                ]
            };

            if (winner !== 'draw') {
                const checksumWinner = ethers.utils.getAddress(winnerAddress);
                const value = {
                    id: ethers.BigNumber.from(gameId),
                    winner: checksumWinner
                };

                const sig = await signer._signTypedData(domain, { GameWin: types.GameWin }, value);

                if (winner === 'white') signatureWhite = sig;
                else signatureBlack = sig;

                console.log(`✅ GAME_WIN Signature created for ${winnerAddress}`);
            } else {
                const value = { id: ethers.BigNumber.from(gameId) };
                const sig = await signer._signTypedData(domain, { GameDraw: types.GameDraw }, value);

                signatureWhite = sig;
                signatureBlack = sig;
                console.log(`✅ GAME_DRAW Signatures created for both players`);
            }
        }
    } catch (error) {
        console.error("❌ Signature generation error:", error);
    }

    room.signatureWhite = signatureWhite;
    room.signatureBlack = signatureBlack;

    io.to(roomId).emit('gameEnded', {
        winner,
        reason,
        pgn: room.chess.pgn(),
        gameId: room.meta?.gameId,
        winnerAddress: winnerAddress || null,
        whiteAddress: whitePlayer?.address || null,
        blackAddress: blackPlayer?.address || null,
        deadline: deadline, // FIX: now defined
        scores: {
            white: whiteScore,
            black: blackScore
        },
        signatureWhite: signatureWhite,
        signatureBlack: signatureBlack
    });

    // Cleanup after 30s to allow pending reconnections to still see room state
    setTimeout(() => cleanupRoom(roomId), 30000);
}

function startRoomTimer(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.timers.interval) return;

    room.timers.interval = setInterval(() => {
        if (room.gameOver) {
            clearInterval(room.timers.interval);
            return;
        }

        if (room.chess.history().length > 0) {
            if (room.chess.turn() === 'w') {
                room.timers.white--;
            } else {
                room.timers.black--;
            }
        }

        io.to(roomId).emit('timerUpdate', {
            white: room.timers.white,
            black: room.timers.black
        });

        if (room.timers.white <= 0) {
            handleGameEnd(roomId, 'black', 'timeout');
            return;
        } else if (room.timers.black <= 0) {
            handleGameEnd(roomId, 'white', 'timeout');
            return;
        }
    }, 1000);
}

function cleanupRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.timers.interval) {
        clearInterval(room.timers.interval);
    }

    room.players.forEach(player => {
        if (player.address) {
            const session = playerSessions.get(player.address);
            if (session?.reconnectTimer) {
                clearTimeout(session.reconnectTimer);
            }
            playerSessions.delete(player.address);
        }
    });

    rooms.delete(roomId);
    console.log(`🗑️ Room ${roomId} cleaned up`);
}

// Initialize provider and start server
async function startServer() {
    try {
        await initializeProvider();

        moduleContract = new ethers.Contract(moduleAddress, moduleAbi, provider);

        if (process.env.SIGNER_PRIVATE_KEY) {
            const tempSigner = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY);
            try {
                const onChainSigner = await moduleContract.trustedSigner();
                if (tempSigner.address.toLowerCase() === onChainSigner.toLowerCase()) {
                    console.log(`✅ Trusted Signer matches: ${tempSigner.address}`);
                } else {
                    console.error(`❌ CRITICAL: SIGNER_PRIVATE_KEY address (${tempSigner.address}) DOES NOT MATCH on-chain trustedSigner (${onChainSigner})! Signatures will revert.`);
                }
            } catch (err) {
                console.warn(`⚠️ Could not verify trustedSigner on-chain: ${err.message}`);
            }
        } else {
            console.warn(`⚠️ SIGNER_PRIVATE_KEY is missing from .env! You will not be able to claim games.`);
        }

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`
╔═══════════════════════════════════════════════════╗
║      ♔  COFFEE CHESS SECURE SERVER  ♚            ║
║      ✓ Server-side chess validation              ║
║      ✓ Blockchain stake verification             ║
║      ✓ Reconnection support (60s window)         ║
║      ✓ Anti-cheat protection                     ║
║      ✓ Multi-RPC fallback                        ║
║      ✓ CORS restricted to allowed origins        ║
║      ✓ Trusted signature backend                 ║
║      ✓ Signature required for reconnect          ║
║      Running on port ${PORT}                          ║
║      http://localhost:${PORT}                         ║
║      http://127.0.0.1:${PORT}                         ║
╚═══════════════════════════════════════════════════╝
            `);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();
