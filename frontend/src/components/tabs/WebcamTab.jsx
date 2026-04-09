// ─────────────────────────────────────────────────────────
//  Webcam Tab — live camera with canvas overlay
//  (Simulates bounding box; real boxes drawn by Python/OpenCV)
// ─────────────────────────────────────────────────────────
import { useRef, useState, useEffect } from 'react'
import { motion } from 'framer-motion'

export default function WebcamTab({ detection }) {
  const { status } = detection
  const videoRef   = useRef(null)
  const canvasRef  = useRef(null)
  const streamRef  = useRef(null)
  const animRef    = useRef(null)

  const [camActive,   setCamActive]   = useState(false)
  const [camError,    setCamError]    = useState('')
  const [frameCount,  setFrameCount]  = useState(0)
  const [localDetect, setLocalDetect] = useState(0)

  // Keep a ref of status to avoid stale closure
  const statusRef = useRef(status)
  useEffect(() => { statusRef.current = status }, [status])

  async function startCamera() {
    setCamError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      })
      streamRef.current    = stream
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      setCamActive(true)
      startOverlay()
    } catch (err) {
      setCamError(`Camera error: ${err.message}`)
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (animRef.current) {
      cancelAnimationFrame(animRef.current)
      animRef.current = null
    }
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    setCamActive(false)
    setFrameCount(0)
    setLocalDetect(0)
  }

  function startOverlay() {
    const video  = videoRef.current
    const canvas = canvasRef.current
    const ctx    = canvas.getContext('2d')
    let fc = 0

    function draw() {
      animRef.current = requestAnimationFrame(draw)
      fc++
      setFrameCount(fc)

      canvas.width  = video.videoWidth  || 640
      canvas.height = video.videoHeight || 480

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const st = statusRef.current

      // If backend says fire detected, draw a bounding box overlay
      if (st.fire_detected) {
        const cx = canvas.width  * 0.4 + Math.sin(fc * 0.05) * 30
        const cy = canvas.height * 0.4 + Math.cos(fc * 0.04) * 20
        const bw = 160 + Math.sin(fc * 0.08) * 20
        const bh = 120 + Math.cos(fc * 0.07) * 15
        const x  = cx - bw / 2
        const y  = cy - bh / 2

        // Outer glow
        ctx.shadowColor = '#FF2D00'
        ctx.shadowBlur  = 16
        ctx.strokeStyle = '#FF2D00'
        ctx.lineWidth   = 3
        ctx.strokeRect(x, y, bw, bh)
        ctx.shadowBlur  = 0

        // Corner brackets
        drawCorners(ctx, x, y, bw, bh, '#FF2D00')

        // Label
        const conf = st.confidence
        ctx.fillStyle = 'rgba(255,45,0,0.85)'
        ctx.fillRect(x, y - 28, 140, 28)
        ctx.fillStyle = '#ffffff'
        ctx.font      = 'bold 13px "Share Tech Mono", monospace'
        ctx.fillText(`fire  ${conf}%`, x + 8, y - 8)

        setLocalDetect(prev => prev + 1)
      }

      // Scan line
      const scanY  = (fc * 2) % canvas.height
      const grad   = ctx.createLinearGradient(0, scanY - 6, 0, scanY + 6)
      grad.addColorStop(0, 'transparent')
      grad.addColorStop(0.5, 'rgba(255,107,0,0.06)')
      grad.addColorStop(1, 'transparent')
      ctx.fillStyle = grad
      ctx.fillRect(0, scanY - 6, canvas.width, 12)

      // Corner crosshairs
      drawCrosshairs(ctx, canvas.width, canvas.height)
    }

    draw()
  }

  useEffect(() => () => stopCamera(), [])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-5"
    >
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Frames',    value: frameCount },
          { label: 'Detections', value: localDetect },
          { label: 'FPS',       value: status.fps || '—' },
        ].map(m => (
          <div key={m.label} className="card text-center">
            <div className="font-display text-2xl font-bold text-fire-orange">{m.value}</div>
            <div className="font-mono text-xs text-muted tracking-widest uppercase mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Camera view */}
      <div className="card flex flex-col items-center">
        {!camActive ? (
          <div className="text-center py-12">
            <div className="text-5xl mb-4">📷</div>
            <p className="text-muted mb-6 text-sm">Start your webcam to enable live overlay detection</p>
            {camError && <p className="text-fire-red text-sm mb-4 font-mono">{camError}</p>}
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={startCamera}
              className="px-8 py-3 rounded-xl bg-gradient-to-r from-fire-red to-fire-orange text-white font-display font-bold tracking-widest text-sm uppercase"
            >
              ▶ START WEBCAM
            </motion.button>
          </div>
        ) : (
          <>
            <div className="relative inline-block border-2 border-fire-red/40 rounded-xl overflow-hidden shadow-[0_0_40px_rgba(255,45,0,0.2)]">
              <video ref={videoRef} muted className="block w-full max-w-2xl" style={{ maxHeight: '480px' }} />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
              {/* HUD overlay */}
              <div className="absolute top-3 left-3 right-3 flex justify-between pointer-events-none">
                <div className={`font-mono text-xs px-3 py-1 rounded-full border ${status.fire_detected ? 'bg-fire-red/80 border-fire-red text-white' : 'bg-black/50 border-white/10 text-green-400'}`}>
                  {status.fire_detected ? '🔥 FIRE DETECTED' : '● MONITORING'}
                </div>
                <div className="font-mono text-xs px-3 py-1 rounded-full bg-black/50 border border-white/10 text-white">
                  {status.fps} FPS
                </div>
              </div>
            </div>
            <button
              onClick={stopCamera}
              className="mt-4 px-6 py-2 rounded-xl border border-red-500/30 text-red-400 text-xs font-mono hover:bg-red-500/10 transition-colors tracking-wider"
            >
              ⏹ STOP WEBCAM
            </button>
          </>
        )}
      </div>

      {/* Note */}
      <div className="card border-blue-500/20 bg-blue-500/5">
        <p className="text-xs text-muted leading-relaxed">
          <span className="text-blue-400 font-mono">ℹ NOTE:</span> This webcam feed shows a simulated overlay.
          Real YOLOv8 bounding boxes are drawn by the Python backend (<code className="text-fire-orange">fire_ws.py</code>)
          running on your server. Start detection via the top bar to activate the Python pipeline.
        </p>
      </div>
    </motion.div>
  )
}

function drawCorners(ctx, x, y, w, h, color) {
  const len = 20
  ctx.strokeStyle = color
  ctx.lineWidth   = 3
  ctx.shadowColor = color
  ctx.shadowBlur  = 8
  // TL
  ctx.beginPath(); ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.stroke()
  // TR
  ctx.beginPath(); ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len); ctx.stroke()
  // BL
  ctx.beginPath(); ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h); ctx.stroke()
  // BR
  ctx.beginPath(); ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - len); ctx.stroke()
  ctx.shadowBlur = 0
}

function drawCrosshairs(ctx, w, h) {
  const size = 12
  ctx.strokeStyle = 'rgba(255,107,0,0.25)'
  ctx.lineWidth   = 1
  const corners = [[0, 0], [w, 0], [0, h], [w, h]]
  corners.forEach(([cx, cy]) => {
    const dx = cx === 0 ? size : -size
    const dy = cy === 0 ? size : -size
    ctx.beginPath(); ctx.moveTo(cx, cy + dy); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx, cy); ctx.stroke()
  })
}
