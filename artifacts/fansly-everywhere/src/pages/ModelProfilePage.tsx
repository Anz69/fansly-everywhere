import { useState, useEffect } from 'react'
import { Link } from 'wouter'
import { getModel, type Model, type User } from '../api'

type Props = { slug: string; user: User | null }

function fmtCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

export default function ModelProfilePage({ slug, user }: Props) {
  const [model, setModel]     = useState<Model | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    getModel(slug)
      .then(m => {
        if (!m) setError('Model not found')
        else setModel(m)
        setLoading(false)
      })
      .catch(() => {
        setError('Loading error')
        setLoading(false)
      })
  }, [slug])

  useEffect(() => {
    if (model) {
      document.title = `Fansly - ${model.name}`
    }
    return () => { document.title = 'Fansly - Start Interacting With Your Fans' }
  }, [model])

  if (loading) return (
    <div style={{ textAlign: 'center', padding: '6rem', color: '#444' }}>
      Loading...
    </div>
  )

  if (error || !model) return (
    <div style={{ textAlign: 'center', padding: '6rem', color: '#666' }}>
      <p style={{ marginBottom: '1rem' }}>{error || 'Not found'}</p>
      <Link href='/'>
        <a style={{ color: '#2AABEE', textDecoration: 'none', fontSize: 14 }}>
          ← Back to models
        </a>
      </Link>
    </div>
  )

  const photos = (model.photos && model.photos.length > 0)
    ? model.photos.map((src, idx) => ({ src, key: `photo-${idx}-${src.slice(-8)}` }))
    : [model.coverUrl, model.avatarUrl].filter(Boolean).map((src, idx) => ({ src, key: `fallback-${idx}` }))

  const photoCount = model.photoCount ?? model.photos?.length ?? 0
  const videoCount = model.videoCount ?? 0
  const likeCount  = model.likeCount ?? 0
  const followerCount = model.followerCount ?? 0

  const stats = [
    { value: likeCount,     label: 'Likes' },
    { value: followerCount, label: 'Followers' },
    { value: photoCount,    label: 'Photos' },
    { value: videoCount,    label: 'Videos' },
  ]

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', paddingBottom: '4rem' }}>

      {/* Cover */}
      <div style={{ position: 'relative', height: 280, background: '#111', overflow: 'hidden' }}>
        <img
          src={model.coverUrl}
          alt=''
          style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 25%' }}
        />
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(to bottom, transparent 40%, #0a0a0a 100%)',
        }} />
      </div>

      {/* Profile block */}
      <div style={{ padding: '0 1.5rem' }}>

        {/* Avatar row */}
        <div style={{
          position: 'relative', marginTop: -54, marginBottom: '1rem',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 12,
        }}>
          <img
            src={model.avatarUrl}
            alt={model.name}
            style={{
              width: 100, height: 100, borderRadius: '50%',
              border: '4px solid #0a0a0a', objectFit: 'cover',
              objectPosition: 'top center', background: '#222', display: 'block',
            }}
          />
        </div>

        {/* Name + badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 800, lineHeight: 1.2 }}>
            {model.name}
          </h1>
          {model.isVerified && (
            <span title="Verified" style={{ fontSize: 18, lineHeight: 1 }}>✅</span>
          )}
          {model.isOnline && (
            <span style={{
              fontSize: 11, fontWeight: 700, color: '#4ade80',
              background: '#0f2d0f', borderRadius: 6, padding: '2px 8px',
            }}>LIVE</span>
          )}
        </div>

        {/* Username */}
        {model.slug && (
          <p style={{ margin: '0 0 12px', color: '#666', fontSize: 14 }}>
            @{model.slug}
          </p>
        )}

        {/* Stats row */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '6px 24px',
          marginBottom: '1.25rem', alignItems: 'center',
        }}>
          {stats.map(({ value, label }) => (
            <span key={label} style={{ fontSize: 14, color: '#ccc', whiteSpace: 'nowrap' }}>
              <strong style={{ color: '#fff', fontWeight: 700 }}>{fmtCount(value)}</strong>
              {' '}
              <span style={{ color: '#666' }}>{label}</span>
            </span>
          ))}
        </div>

        {/* Bio */}
        {model.bio && (
          <p style={{ color: '#aaa', fontSize: 14, lineHeight: 1.7, marginBottom: '1.5rem', maxWidth: 600 }}>
            {model.bio}
          </p>
        )}

        {/* Login CTA for guests */}
        {!user && (
          <div style={{
            padding: '1.75rem', background: '#141414', borderRadius: 16,
            border: '1px solid #2a2a2a', textAlign: 'center', marginBottom: '1.5rem',
          }}>
            <p style={{ color: '#999', marginBottom: '1.25rem', fontSize: 14, lineHeight: 1.6 }}>
              Sign in via Telegram to view photos
            </p>
            <button
              onClick={() => (window as any).showTelegramAuth?.()}
              style={{
                padding: '12px 32px', borderRadius: 12, border: 'none',
                background: '#2AABEE', color: '#fff', fontWeight: 700,
                cursor: 'pointer', fontSize: 15,
              }}
            >
              Sign in via Telegram
            </button>
          </div>
        )}

        {/* Photo grid */}
        {user && photos.length > 0 && (
          <div style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#888', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Photos
            </h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 8,
            }}>
              {photos.map(({ src, key }) => (
                <div key={key} style={{ aspectRatio: '1', borderRadius: 12, overflow: 'hidden', background: '#111' }}>
                  <img
                    src={src}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    loading="lazy"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Chat CTA */}
        {user && (
          <div style={{ marginBottom: '1.5rem' }}>
            <Link href={`/chat/${model.slug}`}>
              <a style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '12px 28px', borderRadius: 12,
                background: '#2AABEE', color: '#fff',
                fontWeight: 700, fontSize: 15, textDecoration: 'none',
              }}>
                💬 Send Message
              </a>
            </Link>
          </div>
        )}

        <Link href='/'>
          <a style={{ color: '#555', textDecoration: 'none', fontSize: 14 }}>
            ← All models
          </a>
        </Link>
      </div>
    </div>
  )
}
