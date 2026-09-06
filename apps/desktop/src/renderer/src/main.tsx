import './styles/globals.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// Main pins Chromium's colour scheme to the user's setting before this window loads, so the
// first frame can already be dark; ThemeProvider takes over with the full palette once mounted.
document.documentElement.classList.toggle(
  'dark',
  window.matchMedia('(prefers-color-scheme: dark)').matches
)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
