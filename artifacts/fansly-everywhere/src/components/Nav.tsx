import { Link } from 'wouter'
import type { User } from '../api'

type Props = {
  user: User | null
  onLogout: () => void
}

export default function Nav({ user, onLogout }: Props) {
  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 100,
      background: 'rgba(10,10,10,0.95)',
      backdropFilter: 'blur(12px)',
      borderBottom: '1px solid #1a1a1a',
      display: 'flex', alignItems: 'center',
      padding: '0 1.5rem', height: 60, gap: '1.5rem',
    }}>
      <Link href="/model/stella-cardo">
        <a style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
          <img
            src="/fansly-logo.png"
            alt="Fansly"
            style={{ height: 40, objectFit: 'contain' }}
            onError={e => {
              const img = e.currentTarget as HTMLImageElement
              img.style.display = 'none'
              const span = document.createElement('span')
              span.textContent = 'Fansly'
              span.style.cssText = 'font-weight:800;font-size:20px;color:#2AABEE;'
              img.parentElement?.appendChild(span)
            }}
          />
        </a>
      </Link>

      <div style={{ flex: 1 }} />

      {user ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          {user.role === 'admin' && (
            <Link href="/admin">
              <a style={{
                padding: '5px 12px', borderRadius: 7,
                border: '1px solid #2AABEE33',
                background: '#2AABEE11',
                color: '#2AABEE',
                fontSize: 12, fontWeight: 700,
                textDecoration: 'none',
              }}>
                Admin
              </a>
            </Link>
          )}
          {user.avatarUrl && (
            <img
              src={user.avatarUrl}
              alt={user.firstName}
              style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover' }}
            />
          )}
          <span style={{ fontSize: 13, color: '#aaa' }}>
            {user.username ? `@${user.username}` : user.firstName}
          </span>
          <button
            onClick={onLogout}
            style={{
              padding: '6px 14px', borderRadius: 8,
              border: '1px solid #2a2a2a', background: 'transparent',
              color: '#666', fontSize: 13, cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </div>
      ) : (
        <button
          onClick={() => (window as any).showTelegramAuth?.()}
          style={{
            padding: '8px 20px', borderRadius: 10, border: 'none',
            background: '#2AABEE', color: '#fff',
            fontWeight: 700, fontSize: 14, cursor: 'pointer',
          }}
        >
          Sign in
        </button>
      )}
    </nav>
  )
}
