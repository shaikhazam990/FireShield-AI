// ─────────────────────────────────────────────────────────
//  Socket Context — single Socket.io connection shared app-wide
// ─────────────────────────────────────────────────────────
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const SocketContext = createContext(null)
const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'

export function SocketProvider({ children }) {
  const socketRef              = useRef(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const socket = io(BACKEND, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket

    socket.on('connect',    () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    return () => socket.disconnect()
  }, [])

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected }}>
      {children}
    </SocketContext.Provider>
  )
}

export function useSocket() {
  return useContext(SocketContext)
}
