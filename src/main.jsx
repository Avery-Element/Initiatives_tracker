import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const root = createRoot(document.getElementById('root'))

// Vite bakes these in at build time; on Cloudflare they must be *build* variables.
const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter(k => !import.meta.env[k])

if (missing.length) {
  root.render(
    <div style={{ fontFamily: 'var(--font-sans)', padding: '2rem', maxWidth: 560, lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 18, fontWeight: 500 }}>Initiatives Tracker isn't configured</h1>
      <p style={{ fontSize: 14 }}>This build is missing: <b>{missing.join(', ')}</b>.</p>
      <p style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>
        In Cloudflare, add them under the Worker's <b>Settings → Build → Variables and secrets</b> (build variables,
        not runtime variables), then redeploy. Locally, copy .env.example to .env.local.
      </p>
    </div>
  )
} else {
  // Loaded only when configured: creating the Supabase client without a URL throws
  import('./App.jsx').then(({ default: App }) => root.render(<StrictMode><App /></StrictMode>))
}
