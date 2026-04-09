// ─────────────────────────────────────────────────────────
//  Gallery Tab — screenshot grid from /detections
// ─────────────────────────────────────────────────────────
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, RefreshCw } from 'lucide-react'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'

export default function GalleryTab({ detection }) {
  const { api } = detection
  const [images,   setImages]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [selected, setSelected] = useState(null)

  function load() {
    setLoading(true)
    api({ method: 'GET', url: '/api/images' })
      .then(r => setImages(r.data.images || []))
      .catch(() => setImages([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xs tracking-[3px] uppercase text-muted">
          Detection Screenshots — {images.length} files
        </h2>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 text-muted text-xs font-mono hover:text-white hover:border-fire-orange/30 transition-colors"
        >
          <RefreshCw size={12} />
          REFRESH
        </button>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="text-center py-20 text-muted font-mono">Loading screenshots...</div>
      ) : images.length === 0 ? (
        <div className="card text-center py-20">
          <div className="text-4xl mb-4">🖼️</div>
          <p className="text-muted text-sm">No screenshots yet.</p>
          <p className="text-muted/60 text-xs mt-2">Screenshots are saved automatically when fire is detected.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {images.map((img, i) => (
            <motion.div
              key={img.filename}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.04 }}
              onClick={() => setSelected(img)}
              className="cursor-pointer group relative rounded-xl overflow-hidden border border-fire-red/20 hover:border-fire-red/60 transition-all duration-200 aspect-video bg-dark-700"
            >
              <img
                src={`${BACKEND}${img.url}`}
                alt={img.filename}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                onError={e => { e.target.style.display = 'none' }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="font-mono text-xs text-white truncate">{img.filename}</p>
              </div>
              <div className="absolute top-2 left-2">
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-fire-red/80 text-white border border-fire-red/60">
                  🔥
                </span>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelected(null)}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.85 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.85 }}
              onClick={e => e.stopPropagation()}
              className="relative max-w-4xl w-full"
            >
              <button
                onClick={() => setSelected(null)}
                className="absolute -top-10 right-0 text-white/60 hover:text-white transition-colors"
              >
                <X size={24} />
              </button>
              <img
                src={`${BACKEND}${selected.url}`}
                alt={selected.filename}
                className="w-full rounded-xl border border-fire-red/30"
              />
              <div className="mt-3 flex items-center justify-between">
                <p className="font-mono text-xs text-muted">{selected.filename}</p>
                <p className="font-mono text-xs text-muted">
                  {new Date(selected.timestamp).toLocaleString()}
                </p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.div>
  )
}
