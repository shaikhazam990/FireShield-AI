// ─────────────────────────────────────────────────────────
//  FireShield AI — server.js  (FIXED)
//
//  FIXES:
//  1. Serves alarm.mp3 at /alarm.mp3 so frontend can play it
//  2. Auto-starts detection on boot (no manual button needed)
//  3. Socket emits current boxes + gallery count on connect
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

const authRoutes       = require('./routes/auth');
const apiRoutes        = require('./routes/api');
const detectionService = require('./services/detectionService');

require('./config/passport');

const app    = express();
const server = http.createServer(app);

// ── Socket.io ────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      process.env.FRONTEND_URL || 'http://localhost:5173',
    methods:     ['GET', 'POST'],
    credentials: true,
  },
});

app.set('io', io);
detectionService.setIO(io);

// ── Middleware ───────────────────────────────────────────
app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));

app.use(session({
  secret:            process.env.SESSION_SECRET || 'fireshield_secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:  process.env.NODE_ENV === 'production',
    maxAge:  7 * 24 * 60 * 60 * 1000,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// ── FIX: Serve alarm.mp3 at /alarm.mp3 ──────────────────
// Frontend Audio() fetches from VITE_BACKEND_URL/alarm.mp3
const alarmFile = path.join(__dirname, 'alarm.mp3');
if (fs.existsSync(alarmFile)) {
  app.get('/alarm.mp3', (req, res) => res.sendFile(alarmFile));
  console.log('[Server] alarm.mp3 found and served at /alarm.mp3');
} else {
  console.warn('[Server] alarm.mp3 NOT found — frontend alarm will be silent');
}

// ── Static: detection screenshots ───────────────────────
const detectionsDir = path.join(__dirname, 'detections');
if (!fs.existsSync(detectionsDir)) fs.mkdirSync(detectionsDir, { recursive: true });
app.use('/detections', express.static(detectionsDir));

// ── Routes ───────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api',  apiRoutes);

app.get('/health', (req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ── WebSocket Events ─────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send current state immediately on connect
  socket.emit('status', detectionService.getStatus());

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ── Start server ─────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
  console.log(`\n🔥 FireShield AI Backend — port ${PORT}`);
  console.log(`   Frontend : ${process.env.FRONTEND_URL}`);
  console.log(`   Env      : ${process.env.NODE_ENV || 'development'}`);

  // FIX: Auto-start detection so it runs without hitting the button
  console.log('\n[Detection] Auto-starting...');
  try {
    await detectionService.start();
  } catch (err) {
    console.error('[Detection] Auto-start failed:', err.message);
  }
});

module.exports = { app, io };
