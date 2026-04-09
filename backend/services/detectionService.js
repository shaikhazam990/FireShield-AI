// ─────────────────────────────────────────────────────────
//  Detection Service
//  Spawns fire_ws.py as child process. If Python/model is
//  unavailable, automatically falls back to DEMO mode.
// ─────────────────────────────────────────────────────────
const { spawn }      = require('child_process');
const path           = require('path');
const fs             = require('fs');
const { v4: uuidv4 } = require('uuid');

let io           = null;
let pyProcess    = null;
let demoInterval = null;
let isRunning    = false;
let startTime    = null;
let logs         = [];

// ── Live state broadcast to all socket clients ────────────
let state = {
  fire_detected:       false,
  confidence:          0,
  total_detections:    0,
  last_detection_time: null,
  fps:                 0,
  uptime_seconds:      0,
  is_running:          false,
  mode:                'idle',   // 'idle' | 'python' | 'demo'
};

// ── Inject Socket.io instance (called from server.js) ─────
function setIO(socketIO) {
  io = socketIO;
}

// ── Start detection ───────────────────────────────────────
async function start() {
  if (isRunning) return;

  isRunning        = true;
  startTime        = Date.now();
  state.is_running = true;

  const pythonPath = process.env.PYTHON_PATH || 'python3';
  const scriptPath = path.join(__dirname, '..', 'fire_ws.py');
  const modelPath  = process.env.MODEL_PATH  || 'models/fire.pt';
  const modelExists  = fs.existsSync(path.join(__dirname, '..', modelPath));
  const scriptExists = fs.existsSync(scriptPath);

  // Fall back to demo if script or model is missing
  if (!scriptExists || !modelExists) {
    const reason = !scriptExists ? 'fire_ws.py not found' : `model not found at ${modelPath}`;
    console.warn(`[Detection] ${reason} — starting DEMO mode`);
    startDemoMode();
    broadcastStatus();
    return;
  }

  console.log(`[Detection] Spawning Python: ${pythonPath} ${scriptPath}`);
  state.mode = 'python';

  pyProcess = spawn(pythonPath, [scriptPath, '--model', modelPath], {
    cwd: path.join(__dirname, '..'),
  });

  // Give Python 8 seconds to emit its first frame.
  // If nothing comes, fall back to demo mode automatically.
  const fallbackTimer = setTimeout(() => {
    if (isRunning && state.fps === 0) {
      console.warn('[Detection] No frames received from Python after 8s — falling back to DEMO mode');
      if (pyProcess) { pyProcess.kill(); pyProcess = null; }
      startDemoMode();
    }
  }, 8000);

  // ── Parse JSON lines from Python stdout ──────────────────
  pyProcess.stdout.on('data', (data) => {
    clearTimeout(fallbackTimer);
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        handlePythonEvent(JSON.parse(line));
      } catch {
        console.log(`[Python stdout] ${line}`);
      }
    }
  });

  pyProcess.stderr.on('data', (data) => {
    // YOLO prints a lot to stderr during loading — only log real errors
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error')) {
      console.error(`[Python ERR] ${msg.trim()}`);
    }
  });

  pyProcess.on('close', (code) => {
    clearTimeout(fallbackTimer);
    console.log(`[Detection] Python exited with code ${code}`);
    // If it exited unexpectedly while we're still "running", fall back to demo
    if (isRunning) {
      console.warn('[Detection] Python crashed — falling back to DEMO mode');
      startDemoMode();
    }
  });

  pyProcess.on('error', (err) => {
    clearTimeout(fallbackTimer);
    console.error(`[Detection] Failed to spawn Python: ${err.message}`);
    console.warn('[Detection] Falling back to DEMO mode');
    startDemoMode();
  });

  broadcastStatus();
}

// ── Handle JSON events from Python stdout ─────────────────
function handlePythonEvent(event) {
  if (event.type !== 'frame') return;

  const wasDetected    = state.fire_detected;
  state.fire_detected  = event.fire_detected;
  state.confidence     = parseFloat((event.confidence || 0).toFixed(1));
  state.fps            = parseFloat((event.fps        || 0).toFixed(1));
  state.uptime_seconds = Math.floor((Date.now() - startTime) / 1000);

  if (event.fire_detected) {
    state.total_detections++;
    state.last_detection_time = new Date().toISOString();
    const entry = addLog({ confidence: state.confidence, severity: getSeverity(state.confidence), fps: state.fps });
    if (!wasDetected) {
      io?.emit('fire_detected', { confidence: state.confidence, log: entry });
    }
  }

  broadcastStatus();
}

// ── Demo mode — realistic simulated fire events ───────────
function startDemoMode() {
  // Don't start twice
  if (demoInterval) return;

  state.mode       = 'demo';
  state.is_running = true;
  if (!startTime) startTime = Date.now();

  console.log('[Detection] DEMO mode running — simulating fire events');

  let tick = 0;

  demoInterval = setInterval(() => {
    tick++;

    // Simulate realistic pattern: mostly clear, occasional fire bursts
    const inBurst   = (tick % 40) > 30;          // fire burst every 40 ticks
    const detected  = inBurst && Math.random() > 0.3;
    const conf      = detected
      ? parseFloat((76 + Math.random() * 20).toFixed(1))   // 76–96%
      : parseFloat((5  + Math.random() * 25).toFixed(1));  // 5–30%

    const wasDetected       = state.fire_detected;
    state.fire_detected     = detected;
    state.confidence        = conf;
    state.fps               = parseFloat((12 + Math.random() * 6).toFixed(1));
    state.uptime_seconds    = Math.floor((Date.now() - startTime) / 1000);
    state.is_running        = true;

    if (detected) {
      state.total_detections++;
      state.last_detection_time = new Date().toISOString();
      const entry = addLog({
        confidence: state.confidence,
        severity:   getSeverity(state.confidence),
        fps:        state.fps,
      });
      if (!wasDetected) {
        io?.emit('fire_detected', { confidence: state.confidence, log: entry });
      }
    }

    broadcastStatus();
  }, 500);
}

// ── Stop detection ────────────────────────────────────────
async function stop() {
  isRunning            = false;
  state.is_running     = false;
  state.fire_detected  = false;
  state.fps            = 0;
  state.mode           = 'idle';

  if (pyProcess) {
    pyProcess.kill('SIGTERM');
    pyProcess = null;
  }

  if (demoInterval) {
    clearInterval(demoInterval);
    demoInterval = null;
  }

  broadcastStatus();
}

// ── Broadcast current state to all Socket.io clients ─────
function broadcastStatus() {
  io?.emit('status', getStatus());
}

// ── Add a log entry + emit to clients ─────────────────────
function addLog({ confidence, severity, fps }) {
  const entry = {
    id:         uuidv4(),
    timestamp:  new Date().toISOString(),
    confidence: parseFloat((confidence || 0).toFixed(1)),
    severity,
    fps:        parseFloat((fps        || 0).toFixed(1)),
  };
  logs.unshift(entry);
  if (logs.length > 500) logs = logs.slice(0, 500);
  io?.emit('log', entry);
  return entry;
}

// ── Helpers ───────────────────────────────────────────────
function getSeverity(confidence) {
  if (confidence >= 85) return 'HIGH';
  if (confidence >= 70) return 'MED';
  return 'LOW';
}

function getStatus() {
  return { ...state, log_count: logs.length };
}

function getLogs(limit = 100) {
  return logs.slice(0, limit);
}

function getAnalytics() {
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: i, detections: 0, avg_conf: 0,
  }));

  logs.forEach(log => {
    const h = new Date(log.timestamp).getHours();
    hourly[h].detections++;
    hourly[h].avg_conf = parseFloat(
      ((hourly[h].avg_conf + log.confidence) / 2).toFixed(1)
    );
  });

  const severityCounts = { HIGH: 0, MED: 0, LOW: 0 };
  logs.forEach(l => {
    if (severityCounts[l.severity] !== undefined) severityCounts[l.severity]++;
  });

  return {
    hourly,
    severity_distribution: severityCounts,
    total_detections:      state.total_detections,
    uptime_seconds:        state.uptime_seconds,
    mode:                  state.mode,
  };
}

module.exports = { setIO, start, stop, getStatus, getLogs, getAnalytics };