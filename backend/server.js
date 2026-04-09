// ─────────────────────────────────────────────────────────
//  FireShield AI — Backend Server
//  Express + Socket.io + Passport Google OAuth
// ─────────────────────────────────────────────────────────
require('dotenv').config();
const express       = require('express');
const http          = require('http');
const cors          = require('cors');
const cookieParser  = require('cookie-parser');
const session       = require('express-session');
const passport      = require('passport');
const morgan        = require('morgan');
const path          = require('path');
const fs            = require('fs');
const { Server }    = require('socket.io');

const authRoutes      = require('./routes/auth');
const apiRoutes       = require('./routes/api');
const detectionService = require('./services/detectionService');

require('./config/passport');  // Configure Passport strategies

const app    = express();
const server = http.createServer(app);

// ── Socket.io ────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Make io available to routes/services
app.set('io', io);
detectionService.setIO(io);

// ── Middleware ───────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fireshield_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// ── Static files (screenshot gallery) ───────────────────
const detectionsDir = path.join(__dirname, 'detections');
if (!fs.existsSync(detectionsDir)) fs.mkdirSync(detectionsDir, { recursive: true });
app.use('/detections', express.static(detectionsDir));

// ── Routes ───────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── WebSocket Events ─────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send current status immediately on connect
  socket.emit('status', detectionService.getStatus());

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ── Start ────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🔥 FireShield AI Backend running on port ${PORT}`);
  console.log(`   Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log(`   Environment:  ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = { app, io };
