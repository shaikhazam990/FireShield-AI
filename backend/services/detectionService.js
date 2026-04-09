// ─────────────────────────────────────────────────────────
//  Detection Service
//  Spawns fire.py as a child process, parses its stdout,
//  maintains state, and broadcasts via Socket.io
// ─────────────────────────────────────────────────────────
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const { v4: uuidv4 } = require('uuid');

let io          = null;   // Socket.io instance
let pyProcess   = null;   // Python child process
let isRunning   = false;

// ── In-memory state ───────────────────────────────────────
let state = {
  fire_detected:    false,
  confidence:       0,
  total_detections: 0,
  last_detection_time: null,
  fps:              0,
  uptime_seconds:   0,
  is_running:       false,
};

let logs      = [];   // Detection log entries
let startTime = null;

// ── Simulate detection data when Python isn't available ──
// (for dev/demo mode without a real camera)
let demoInterval = null;

// ── Set Socket.io instance ────────────────────────────────
function setIO(socketIO) {
  io = socketIO;
}

// ── Start Detection ───────────────────────────────────────
async function start() {
  if (isRunning) return;

  isRunning  = true;
  startTime  = Date.now();
  state.is_running = true;

  const pythonPath = process.env.PYTHON_PATH || 'python3';
  const scriptPath = path.join(__dirname, '..', 'fire_ws.py');
  const modelPath  = process.env.MODEL_PATH  || 'models/fire.pt';

  // Check if the Python script exists
  if (!fs.existsSync(scriptPath)) {
    console.warn('[Detection] fire_ws.py not found — running in DEMO mode');
    startDemoMode();
    broadcastStatus();
    return;
  }

  console.log(`[Detection] Spawning: ${pythonPath} ${scriptPath}`);

  pyProcess = spawn(pythonPath, [scriptPath, '--model', modelPath], {
    cwd: path.join(__dirname, '..'),
  });

  // Parse JSON lines from Python stdout
  pyProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        handlePythonEvent(parsed);
      } catch {
        // Non-JSON output (e.g. YOLO loading messages) — just log it
        console.log(`[Python] ${line}`);
      }
    }
  });

  pyProcess.stderr.on('data', (data) => {
    console.error(`[Python ERR] ${data}`);
  });

  pyProcess.on('close', (code) => {
    console.log(`[Detection] Python process exited with code ${code}`);
    isRunning = false;
    state.is_running = false;
    state.fire_detected = false;
    broadcastStatus();
  });

  broadcastStatus();
}

// ── Handle events coming from Python ─────────────────────
function handlePythonEvent(event) {
  if (event.type === 'frame') {
    const wasDetected = state.fire_detected;

    state.fire_detected = event.fire_detected;
    state.confidence    = event.confidence || 0;
    state.fps           = event.fps || 0;
    state.uptime_seconds = Math.floor((Date.now() - startTime) / 1000);

    if (event.fire_detected) {
      state.total_detections++;
      state.last_detection_time = new Date().toISOString();

      const entry = addLog({
        confidence: event.confidence,
        severity:   getSeverity(event.confidence),
        fps:        event.fps,
      });

      // Emit specific fire_detected event for frontend alarm trigger
      if (!wasDetected) {
        io?.emit('fire_detected', { confidence: event.confidence, log: entry });
      }
    }

    broadcastStatus();
  }
}

// ── Demo mode (no camera/Python available) ────────────────
function startDemoMode() {
  let demoFrame = 0;

  demoInterval = setInterval(() => {
    demoFrame++;
    const fireChance = Math.random();
    const detected   = fireChance > 0.85;
    const conf       = detected ? Math.random() * 20 + 76 : Math.random() * 30 + 10;

    state.fire_detected   = detected;
    state.confidence      = parseFloat(conf.toFixed(1));
    state.fps             = parseFloat((14 + Math.random() * 4).toFixed(1));
    state.uptime_seconds  = Math.floor((Date.now() - startTime) / 1000);
    state.is_running      = true;

    if (detected) {
      state.total_detections++;
      state.last_detection_time = new Date().toISOString();
      const entry = addLog({ confidence: state.confidence, severity: getSeverity(state.confidence), fps: state.fps });
      io?.emit('fire_detected', { confidence: state.confidence, log: entry });
    }

    broadcastStatus();
  }, 500);
}

// ── Stop Detection ────────────────────────────────────────
async function stop() {
  isRunning = false;
  state.is_running    = false;
  state.fire_detected = false;

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

// ── Broadcast via Socket.io ───────────────────────────────
function broadcastStatus() {
  if (io) {
    io.emit('status', getStatus());
  }
}

// ── Add log entry ─────────────────────────────────────────
function addLog({ confidence, severity, fps }) {
  const entry = {
    id:          uuidv4(),
    timestamp:   new Date().toISOString(),
    confidence:  parseFloat((confidence || 0).toFixed(1)),
    severity,
    fps:         parseFloat((fps || 0).toFixed(1)),
  };
  logs.unshift(entry);
  if (logs.length > 500) logs = logs.slice(0, 500); // cap at 500 entries
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
  // Build hourly buckets for the last 24h
  const now    = Date.now();
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour:       i,
    detections: 0,
    avg_conf:   0,
  }));

  logs.forEach(log => {
    const h = new Date(log.timestamp).getHours();
    hourly[h].detections++;
    hourly[h].avg_conf = parseFloat(
      ((hourly[h].avg_conf + log.confidence) / 2).toFixed(1)
    );
  });

  const severityCounts = { HIGH: 0, MED: 0, LOW: 0 };
  logs.forEach(l => { if (severityCounts[l.severity] !== undefined) severityCounts[l.severity]++; });

  return {
    hourly,
    severity_distribution: severityCounts,
    total_detections: state.total_detections,
    uptime_seconds:   state.uptime_seconds,
  };
}

module.exports = { setIO, start, stop, getStatus, getLogs, getAnalytics };
