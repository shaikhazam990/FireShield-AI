// ─────────────────────────────────────────────────────────
//  useDetection — subscribes to socket events, manages
//  detection state and confidence history for charts
// ─────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSocket } from '../context/SocketContext'
import { useAuth } from '../context/AuthContext'
import axios from 'axios'
import toast from 'react-hot-toast'

const BACKEND     = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'
const MAX_HISTORY = 60

export function useDetection() {
  const { socket }   = useSocket()
  const { getToken } = useAuth()

  const [status, setStatus] = useState({
    fire_detected:       false,
    confidence:          0,
    total_detections:    0,
    last_detection_time: null,
    fps:                 0,
    uptime_seconds:      0,
    is_running:          false,
    mode:                'idle',
  })

  const [logs,             setLogs]        = useState([])
  const [confidenceHistory, setConfHistory] = useState([])
  const [isStarting,       setIsStarting]  = useState(false)

  const alarmRef    = useRef(null)
  const prevFireRef = useRef(false)  // track previous fire state to avoid duplicate alarms

  // ── Stable axios helper (won't change between renders) ──
  const api = useCallback((config) => {
    return axios({
      ...config,
      url:     `${BACKEND}${config.url}`,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...config.headers,
      },
    })
  }, [getToken])

  // ── Load alarm audio lazily ───────────────────────────
  function getAlarm() {
    if (!alarmRef.current) {
      alarmRef.current = new Audio('/alarm.mp3')
      alarmRef.current.loop = false
    }
    return alarmRef.current
  }

  // ── Socket event listeners ────────────────────────────
  useEffect(() => {
    if (!socket) return

    // ── status update (every 500ms from backend) ─────────
    function onStatus(data) {
      setStatus(data)

      // Append to confidence chart history
      setConfHistory(prev => {
        const point = {
          time:       new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          confidence: data.confidence,
          fps:        data.fps,
        }
        return [...prev, point].slice(-MAX_HISTORY)
      })

      // Clear alarm flag when fire stops
      if (!data.fire_detected) {
        prevFireRef.current = false
      }
    }

    // ── new fire detection event ──────────────────────────
    function onFireDetected({ confidence }) {
      if (prevFireRef.current) return  // already alarming
      prevFireRef.current = true

      // Play alarm sound
      try {
        const alarm = getAlarm()
        alarm.currentTime = 0
        alarm.play().catch(() => {})
      } catch {}

      // Toast notification
      toast.error(`🔥 FIRE DETECTED — ${confidence}% confidence`, {
        duration: 6000,
        style: {
          background: '#FF2D00',
          color:      '#fff',
          fontWeight: '700',
          border:     '1px solid #FF6B00',
          fontFamily: 'Rajdhani, sans-serif',
          fontSize:   '15px',
        },
      })
    }

    // ── new log entry streamed in real-time ───────────────
    function onLog(entry) {
      setLogs(prev => [entry, ...prev].slice(0, 200))
    }

    socket.on('status',        onStatus)
    socket.on('fire_detected', onFireDetected)
    socket.on('log',           onLog)

    // Load existing logs on mount
    api({ method: 'GET', url: '/api/logs', params: { limit: 100 } })
      .then(r => setLogs(r.data.logs || []))
      .catch(() => {})

    return () => {
      socket.off('status',        onStatus)
      socket.off('fire_detected', onFireDetected)
      socket.off('log',           onLog)
    }
  }, [socket])   // only re-run if socket instance changes

  // ── Start detection ───────────────────────────────────
  async function startDetection() {
    setIsStarting(true)
    try {
      await api({ method: 'POST', url: '/api/start-detection' })
      toast.success('🔥 Detection started', { duration: 3000 })
    } catch {
      toast.error('Failed to start detection')
    } finally {
      setIsStarting(false)
    }
  }

  // ── Stop detection ────────────────────────────────────
  async function stopDetection() {
    try {
      await api({ method: 'POST', url: '/api/stop-detection' })
      toast('Detection stopped', { icon: '⏹', duration: 3000 })
    } catch {
      toast.error('Failed to stop detection')
    }
  }

  // ── Export CSV — opens download in new tab ────────────
  function exportCSV() {
    window.open(`${BACKEND}/api/logs/export?token=${getToken()}`, '_blank')
  }

  return {
    status,
    logs,
    confidenceHistory,
    isStarting,
    startDetection,
    stopDetection,
    exportCSV,
    api,
  }
}