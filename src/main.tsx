import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import PermitMap from './PermitMap.tsx'

// Simple path-based routing — no router library needed
const isPermitMap = window.location.pathname.startsWith('/permits');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPermitMap ? <PermitMap /> : <App />}
  </StrictMode>,
)
