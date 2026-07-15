import { useState, useEffect } from 'react'
import { Link } from 'wouter'
import ModelCard from '../components/ModelCard'
import { getModels, type Model, type User } from '../api'

const CATEGORIES = [
  { id: 'all',       label: 'All',       tags: [] as string[] },
  { id: 'exclusive', label: 'Exclusive', tags: ['exclusive'] },
  { id: 'premium',   label: 'Premium',   tags: ['premium'] },
  { id: 'lifestyle', label: 'Lifestyle', tags: ['lifestyle'] },
  { id: 'intimate',  label: 'Intimate',  tags: ['intimate'] },
]

type Props = { user: User | null; authReady: boolean }

export default function ModelsPage({ user, authReady }: Props) {
  const [models, setModels]     = useState<Model[]>([])
  const [online, setOnline]     = useState<Model[]>([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [category, setCategory] = useState('all')

  useEffect(() => {
    setLoading(true)
    Promise.all([
      getModels({ limit: 100 }),
      fetch('/api/models/suggestions', { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    ]).then(([all, sugg]) => {
      setModels(all.items)
      setOnline(Array.isArray(sugg) ? sugg : [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const filtered = models.filter(m => {
    const matchSearch = !search || m.name.toLowerCase().includes(search.toLowerCase())
    const cat = CATEGORIES.find(c => c.id === category)
    const matchCat = !cat || cat.id === 'all' || cat.tags.some(t => m.tags.includes(t))
    return matchSearch && matchCat
  })

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '1.5rem 1.25rem 3rem' }}>

      {/* Hero banner */}
      <div style={{
        position: 'relative', borderRadius: 16, overflow: 'hidden',
        height: 200, marginBottom: '2rem',
        background: '#111',
      }}>
        <img
          src="/banner.png"
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, rgba(0,0,0,0.7) 0%, transparent 60%)',
          display: 'flex', alignItems: 'center', padding: '0 2rem',
        }}>
          <div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: '0 0 6px', color: '#fff' }}>
              Creators
            </h1>
            <p style={{ color: '#ccc', fontSize: 14, margin: 0 }}>
              {models.length} creators — exclusive content
            </p>
          </div>
        </div>
      </div>

      {/* Online NOW */}
      {online.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1rem' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#eee', margin: 0 }}>
              Online now
            </h2>
          </div>
          <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 4 }}>
            {online.map(m => (
              <Link key={m.id} href={`/model/${m.slug}`}>
                <a style={{ textDecoration: 'none', flexShrink: 0, textAlign: 'center', width: 72 }}>
                  <div style={{ position: 'relative', display: 'inline-block' }}>
                    <img
                      src={m.avatarUrl}
                      alt={m.name}
                      style={{
                        width: 64, height: 64, borderRadius: '50%', objectFit: 'cover',
                        objectPosition: 'top center',
                        border: '2px solid #22c55e',
                      }}
                      onError={e => { (e.currentTarget as HTMLImageElement).src = '/avatar.png' }}
                    />
                    <span style={{
                      position: 'absolute', bottom: 2, right: 2,
                      width: 10, height: 10, borderRadius: '50%',
                      background: '#22c55e', border: '2px solid #0a0a0a',
                    }} />
                  </div>
                  <div style={{
                    marginTop: 5, fontSize: 11, color: '#ccc',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    maxWidth: 72,
                  }}>
                    {m.name.split(' ')[0]}
                  </div>
                </a>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Filter row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        marginBottom: '1.25rem',
      }}>
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            onClick={() => setCategory(cat.id)}
            style={{
              padding: '7px 16px', borderRadius: 50,
              border: category === cat.id ? 'none' : '1px solid #2a2a2a',
              background: category === cat.id ? '#2AABEE' : 'transparent',
              color: category === cat.id ? '#fff' : '#666',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {cat.label}
          </button>
        ))}

        <div style={{ flex: 1, minWidth: 140, maxWidth: 240, marginLeft: 'auto' }}>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', padding: '7px 14px', borderRadius: 10,
              border: '1px solid #2a2a2a', background: '#111',
              color: '#fff', fontSize: 13, outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* Model grid */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '1rem' }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} style={{
              background: '#141414', borderRadius: 16, height: 220,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '5rem', color: '#444' }}>
          Nothing found
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
          gap: '1rem',
        }}>
          {filtered.map(m => <ModelCard key={m.id} model={m} />)}
        </div>
      )}
    </div>
  )
}
