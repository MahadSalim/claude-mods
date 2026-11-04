import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isFrameless } from './api'
import { SettingsApp } from './features/SettingsApp'
import './index.css'

document.documentElement.dataset.frameless = String(isFrameless)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
)
