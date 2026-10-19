import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/outfit/latin-300.css'
import '@fontsource/outfit/latin-400.css'
import '@fontsource/outfit/latin-500.css'
import '@fontsource/outfit/latin-600.css'
import '@fontsource/anton/latin-400.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'

document.documentElement.dataset.platform = /Mac/i.test(navigator.platform) ? 'mac' : 'other'
