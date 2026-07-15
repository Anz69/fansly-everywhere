import { Link } from 'wouter'
import type { Model } from '../api'

export default function ModelCard({ model }: { model: Model }) {
  return (
    <Link href={`/model/${model.slug}`}>
      <a style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
        <div
          style={{
            background: '#141414',
            borderRadius: 16,
            overflow: 'hidden',
            border: '1px solid #1e1e1e',
            cursor: 'pointer',
            transition: 'transform .2s ease, border-color .2s ease',
          }}
          onMouseOver={e => {
            const el = e.currentTarget as HTMLElement
            el.style.transform = 'translateY(-3px)'
            el.style.borderColor = 'rgba(42,171,238,0.3)'
          }}
          onMouseOut={e => {
            const el = e.currentTarget as HTMLElement
            el.style.transform = 'none'
            el.style.borderColor = '#1e1e1e'
          }}
        >
          {/* Cover */}
          <div style={{ position: 'relative', height: 110, background: '#1a1a1a', overflow: 'hidden' }}>
            <img
              src={model.coverUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }}
              loading="lazy"
              onError={e => {
                const img = e.currentTarget as HTMLImageElement
                img.style.background = '#1a1a1a'
                img.src = ''
              }}
            />
            {model.isOnline && (
              <span style={{
                position: 'absolute', top: 8, right: 8,
                background: '#22c55e', borderRadius: 20,
                padding: '2px 8px', fontSize: 11, fontWeight: 700, color: '#fff',
              }}>
                ● LIVE
              </span>
            )}
          </div>

          {/* Avatar */}
          <div style={{ padding: '0 12px 14px' }}>
            <div style={{ marginTop: -26, marginBottom: 8, position: 'relative', zIndex: 1 }}>
              <img
                src={model.avatarUrl}
                alt={model.name}
                style={{
                  width: 52, height: 52, borderRadius: '50%',
                  border: '3px solid #141414', objectFit: 'cover',
                  objectPosition: 'top center',
                  background: '#222', display: 'block',
                }}
                loading="lazy"
                onError={e => { (e.currentTarget as HTMLImageElement).src = '/avatar.png' }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: '#fff' }}>{model.name}</span>
              {model.isVerified && <span style={{ color: '#2AABEE', fontSize: 12 }}>✓</span>}
            </div>

            <div style={{ color: '#555', fontSize: 11, marginBottom: 7 }}>
              {model.followerCount >= 1000000
                ? `${(model.followerCount / 1000000).toFixed(1)}M`
                : model.followerCount >= 1000
                ? `${(model.followerCount / 1000).toFixed(0)}K`
                : model.followerCount}{' '}
              followers
            </div>

            {model.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {model.tags.slice(0, 2).map(tag => (
                  <span key={tag} style={{
                    background: '#1e1e1e', borderRadius: 6,
                    padding: '2px 7px', fontSize: 10, color: '#555',
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </a>
    </Link>
  )
}
