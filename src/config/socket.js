const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
    },
    pingTimeout: 60000,
  });

  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id;
        socket.userRole = decoded.role;
      } catch (e) {
        // Allow unauthenticated connections for public events
      }
    }
    next();
  });

io.on('connection', (socket) => {
  logger.info(`Socket connected: ${socket.id} user: ${socket.userId || 'guest'}`)

  if (socket.userId) {
    socket.join(`user:${socket.userId}`)
    if (socket.userRole === 'ADMIN') socket.join('admins')  // ← thêm dòng này, fix luôn bug admin ko nhận được event
  }
  socket.join('public')

  // User tự join/leave phòng ticket
  socket.on('ticket:join', (ticketId) => {
    socket.join(`ticket:${ticketId}`)
  })
  socket.on('ticket:leave', (ticketId) => {
    socket.leave(`ticket:${ticketId}`)
  })

  // Typing indicator
  socket.on('ticket:typing', ({ ticketId, isTyping }) => {
    socket.to(`ticket:${ticketId}`).emit('ticket:typing', {
      userId: socket.userId,
      isTyping
    })
  })

  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.id}`)
  })
})

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket not initialized');
  return io;
};

const emitToUser = (userId, event, data) => {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
};

const emitToAll = (event, data) => {
  if (!io) return;
  io.to('public').emit(event, data);
};

const emitToAdmins = (event, data) => {
  if (!io) return;
  io.to('admins').emit(event, data);
};

module.exports = { initSocket, getIO, emitToUser, emitToAll, emitToAdmins };