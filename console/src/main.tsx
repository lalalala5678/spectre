const ENTRY_MARKER_V9 = 'entry-marker-v9-active'; void ENTRY_MARKER_V9;
// 主题恢复: localStorage → prefers-color-scheme → light
{
  const saved = localStorage.getItem('spectre-theme');
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved ?? (prefersDark ? 'carbon' : 'light');
}
import './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
