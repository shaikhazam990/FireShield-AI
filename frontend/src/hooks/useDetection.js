// ─────────────────────────────────────────────────────────
//  useDetection — subscribes to socket events, manages
//  detection state and confidence history for charts
// ─────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSocket } from '../context/SocketContext'
import { useAuth } from '../context/AuthContext'
import axios from 'axios'
import toast from 'react-hot-toast'

const BACKEND    = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'
const MAX_HISTORY = 60  // keep last 60 data points for charts

export function useDetection() {
  const { socket }  = useSocket()
  const { getToken } = useAuth()

  const [status, setStatus] = useState({
    fire_detected:       false,
    confidence:          0,
    total_detections:    0,
    last_detection_time: null,
    fps:                 0,
    uptime_seconds:      0,
    is_running:          false,
  })

  const [logs,          setLogs]          = useState([])
  const [confidenceHistory, setConfHistory] = useState([])
  const [isStarting,    setIsStarting]    = useState(false)

  const alarmRef  = useRef(null)
  const wasFireRef = useRef(false)

  // ── Lazy-load alarm audio ─────────────────────────────
  function getAlarm() {
    if (!alarmRef.current) {
      alarmRef.current = new Audio('/alarm.mp3')
      alarmRef.current.loop = false
    }
    return alarmRef.current
  }

  // ── Axios helper with auth header ─────────────────────
  const api = useCallback((config) => {
    return axios({
      ...config,
      url: `${BACKEND}${config.url}`,
      headers: { Authorization: `Bearer ${getToken()}`, ...config.headers },
    })
  }, [getToken])

  // ── Socket listeners ──────────────────────────────────
  useEffect(() => {
    if (!socket) return

    socket.on('status', (data) => {
      setStatus(data)

      // Append to confidence history
      setConfHistory(prev => {
        const next = [...prev, {
          time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          confidence: data.confidence,
          fps: data.fps,
        }]
        return next.slice(-MAX_HISTORY)
      })
    })

    socket.on('log', (entry) => {
      setLogs(prev => [entry, ...prev].slice(0, 200))
    })

    socket.on('fire_detected', ({ confidence }) => {
      if (!wasFireRef.current) {
        wasFireRef.current = true
        // Play alarm
        try {
          const alarm = getAlarm()
          alarm.currentTime = 0
          alarm.play().catch(() => {})
        } catch {}
        // Toast notification
        toast.error(`🔥 FIRE DETECTED — ${confidence}% confidence`, {
          duration: 5000,
          style: {
            background: '#FF2D00',
            color: '#fff',
            fontWeight: '600',
            border: '1px solid #FF6B00',
          },
        })
      }
    })

    // Reset alarm flag when fire clears
    socket.on('status', (data) => {
      if (!data.fire_detected) wasFireRef.current = false
    })

    // Load initial logs
    api({ method: 'GET', url: '/api/logs', params: { limit: 100 } })
      .then(r => setLogs(r.data.logs || []))
      .catch(() => {})

    return () => {
      socket.off('status')
      socket.off('log')
      socket.off('fire_detected')
    }
  }, [socket, api])

  // ── Start / Stop ──────────────────────────────────────
  async function startDetection() {
    setIsStarting(true)
    try {
      await api({ method: 'POST', url: '/api/start-detection' })
      toast.success('Detection started')
    } catch (e) {
      toast.error('Failed to start detection')
    } finally {
      setIsStarting(false)
    }
  }

  async function stopDetection() {
    try {
      await api({ method: 'POST', url: '/api/stop-detection' })
      toast('Detection stopped', { icon: '⏹' })
    } catch {
      toast.error('Failed to stop detection')
    }
  }

  async function exportCSV() {
    const token = getToken()
    window.open(`${BACKEND}/api/logs/export?token=${token}`, '_blank')
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
