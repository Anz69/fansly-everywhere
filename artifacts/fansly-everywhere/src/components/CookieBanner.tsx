import { useState } from 'react'

export default function CookieBanner() {
  const [visible, setVisible] = useState(() =>
    localStorage.getItem('cookie_consent') === null
  )

  if (!visible) return null

  const accept = (essential: boolean) => {
    localStorage.setItem('cookie_consent', essential ? 'essential' : 'all')
    setVisible(false)
  }

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9000,
      background: '#1a1a1a',
      borderTop: '1px solid #2a2a2a',
      display: 'flex', alignItems: 'center', gap: '1rem',
      padding: '14px 24px',
      flexWrap: 'wrap',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      {/* Cookie icon */}
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" fill="#2a2a2a" stroke="#444" strokeWidth="1.5" />
        <circle cx="8"  cy="9"  r="1.5" fill="#2AABEE" />
        <circle cx="14" cy="7"  r="1"   fill="#2AABEE" />
        <circle cx="16" cy="13" r="1.5" fill="#2AABEE" />
        <circle cx="9"  cy="15" r="1"   fill="#2AABEE" />
        <circle cx="13" cy="17" r="1.2" fill="#2AABEE" />
      </svg>

      <div style={{ flex: 1, minWidth: 220 }}>
        <span style={{ fontWeight: 700, color: '#fff', fontSize: 14, marginRight: 6 }}>
          We use cookies
        </span>
        <span style={{ color: '#888', fontSize: 13 }}>
          We use essential cookies to run the site, plus optional cookies to improve our service and provide support.{' '}
          <a href="/privacy" style={{ color: '#2AABEE', textDecoration: 'none' }}>Privacy Policy</a>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
        <button
          onClick={() => accept(true)}
          style={{
            padding: '8px 18px', borderRadius: 8,
            border: '1px solid #444', background: 'transparent',
            color: '#ccc', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Essential Only
        </button>
        <button
          onClick={() => accept(false)}
          style={{
            padding: '8px 18px', borderRadius: 8,
            border: 'none', background: '#2AABEE',
            color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Accept All
        </button>
      </div>
    </div>
  )
}
