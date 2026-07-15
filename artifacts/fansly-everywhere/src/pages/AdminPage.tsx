import { useState, useEffect, useRef } from 'react'
import type { User } from '../api'
import type { Model } from '../api'

type AdminModel = Model & { id: number }

type Stats = {
  totalUsers: number
  totalModels: number
  totalSubdomains: number
  totalMessages: number
}

type Subdomain = {
  id: number
  slug: string
  modelId: number
  isActive: boolean
  customTitle: string
  customDescription: string | null
  customColor: string | null
  createdAt: string
}

const EMPTY_FORM = {
  slug: '', name: '', avatarUrl: '', coverUrl: '',
  bio: '', followerCount: 0, likeCount: 0, photoCount: 0, videoCount: 0,
  viewerCount: 0,
  isVerified: false, isOnline: false, isFeatured: false,
  tags: '',
  photos: [] as string[],
}
type FormData = typeof EMPTY_FORM

async function adminFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`/api${path}`, { credentials: 'include', ...opts })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }))
    throw new Error(err.error || r.statusText)
  }
  if (r.status === 204) return null
  return r.json()
}

/** Read files as base64 strings */
async function readFilesAsBase64(files: File[]): Promise<{ name: string; type: string; data: string }[]> {
  return Promise.all(files.map(file =>
    new Promise<{ name: string; type: string; data: string }>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ name: file.name, type: file.type, data: reader.result as string })
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  ))
}

/** Upload files to /api/admin/upload in chunks of 3 to stay under 50MB body limit */
async function uploadFiles(files: FileList): Promise<string[]> {
  const allFiles = Array.from(files)
  const CHUNK_SIZE = 3 // max 3 files per request (3×15MB = 45MB < 50MB Express limit)
  const allUrls: string[] = []

  for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) {
    const chunk = allFiles.slice(i, i + CHUNK_SIZE)
    const encoded = await readFilesAsBase64(chunk)
    const r = await fetch('/api/admin/upload', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: encoded }),
    })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      throw new Error(d.error || 'Upload failed')
    }
    const { urls } = await r.json()
    allUrls.push(...(urls as string[]))
  }
  return allUrls
}

// ─── SVG icon components ─────────────────────────────────────────────────────
const IcoUser = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
  </svg>
)
const IcoStar = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }}>
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
  </svg>
)
const IcoGlobe = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }}>
    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>
)
const IcoChat = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
)
const IcoLock = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
)
const IcoFolder = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
)
const IcoLoader = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4, animation: 'admin-spin 0.8s linear infinite' }}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
)
const IcoCheck = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }}>
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)
const IcoDot = ({ color }: { color: string }) => (
  <svg width="7" height="7" viewBox="0 0 10 10" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }}>
    <circle cx="5" cy="5" r="5" fill={color}/>
  </svg>
)
const IcoLightbulb = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5, flexShrink: 0 }}>
    <line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/>
    <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>
  </svg>
)

// ─── Password login form ────────────────────────────────────────────────────
function PasswordLogin({ onSuccess }: { onSuccess: () => void }) {
  const [pwd, setPwd] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pwd.trim()) return
    setLoading(true)
    setErr(null)
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || 'Wrong password')
      }
      onSuccess()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a' }}>
      <style>{`@keyframes admin-spin { to { transform: rotate(360deg) } }`}</style>
      <form onSubmit={submit} style={{ background: '#161616', borderRadius: 20, padding: '36px 32px', width: 340, display: 'flex', flexDirection: 'column', gap: 16, border: '1px solid #222', boxShadow: '0 8px 60px rgba(0,0,0,.8)' }}>
        <div style={{ textAlign: 'center', marginBottom: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, color: '#2AABEE' }}><IcoLock /></div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#fff' }}>Admin Panel</h2>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#555' }}>Enter password to access</p>
        </div>
        <input type="password" placeholder="Password" value={pwd} onChange={e => setPwd(e.target.value)} autoFocus
          style={{ padding: '12px 16px', borderRadius: 10, border: '1.5px solid #2e2e2e', background: '#111', color: '#fff', fontSize: 15, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', width: '100%' }}
        />
        {err && <div style={{ color: '#f87171', fontSize: 13, textAlign: 'center' }}>{err}</div>}
        <button type="submit" disabled={loading || !pwd.trim()}
          style={{ padding: '13px', borderRadius: 10, border: 'none', background: loading ? '#444' : '#2AABEE', color: '#fff', fontWeight: 700, fontSize: 15, cursor: loading ? 'default' : 'pointer', fontFamily: 'inherit' }}
        >
          {loading ? 'Checking...' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

// ─── Inline image upload button ─────────────────────────────────────────────
function UploadButton({
  label, multiple, accept, onUpload, uploading, setUploading,
}: {
  label: string
  multiple?: boolean
  accept?: string
  onUpload: (urls: string[]) => void
  uploading: boolean
  setUploading: (v: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const urls = await uploadFiles(files)
      onUpload(urls)
    } catch (err: any) {
      alert('Upload error: ' + err.message)
    } finally {
      setUploading(false)
      if (ref.current) ref.current.value = ''
    }
  }

  return (
    <>
      <input ref={ref} type="file" accept={accept ?? 'image/*'} multiple={multiple} style={{ display: 'none' }} onChange={handleChange} />
      <button type="button" onClick={() => ref.current?.click()} disabled={uploading}
        style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid #2AABEE', background: 'transparent', color: uploading ? '#666' : '#2AABEE', fontSize: 13, cursor: uploading ? 'default' : 'pointer', fontFamily: 'inherit', fontWeight: 600, display: 'inline-flex', alignItems: 'center' }}
      >
        {uploading ? <><IcoLoader />Uploading...</> : <><IcoFolder />{label}</>}
      </button>
    </>
  )
}

// ─── Photo grid preview ──────────────────────────────────────────────────────
function PhotoGrid({ photos, onRemove }: { photos: string[]; onRemove: (url: string) => void }) {
  if (!photos.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      {photos.map((url, i) => (
        <div key={url + i} style={{ position: 'relative', width: 80, height: 80 }}>
          <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8, border: '1px solid #333' }} />
          <button onClick={() => onRemove(url)} style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#e05555', color: '#fff', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>×</button>
        </div>
      ))}
    </div>
  )
}

// ─── Main admin panel ────────────────────────────────────────────────────────
export default function AdminPage({ user, authReady }: { user: User | null; authReady?: boolean }) {
  const [adminOk, setAdminOk] = useState<boolean | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [models, setModels] = useState<AdminModel[]>([])
  const [subdomains, setSubdomains] = useState<Subdomain[]>([])
  const [tab, setTab] = useState<'models' | 'subdomains'>('models')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<AdminModel | null>(null)
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // subdomain form
  const [showSubForm, setShowSubForm] = useState(false)
  const [editingSub, setEditingSub] = useState<Subdomain | null>(null)
  const [subForm, setSubForm] = useState({ slug: '', modelId: 0, customTitle: '', customDescription: '', customColor: '', isActive: true })
  const [savingSub, setSavingSub] = useState(false)
  const [subError, setSubError] = useState<string | null>(null)

  const checkAdmin = async () => {
    try {
      await adminFetch('/admin/check')
      setAdminOk(true)
    } catch {
      setAdminOk(false)
    }
  }

  const loadData = async () => {
    const [s, m, subs] = await Promise.all([
      adminFetch('/admin/stats').catch(() => null),
      adminFetch('/admin/models').catch(() => []),
      adminFetch('/admin/subdomains').catch(() => []),
    ])
    if (s) setStats(s)
    setModels(m || [])
    setSubdomains(subs || [])
  }

  useEffect(() => { checkAdmin() }, [])
  useEffect(() => { if (adminOk) loadData() }, [adminOk])

  if (adminOk === null) return <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>Loading...</div>
  if (!adminOk) return <PasswordLogin onSuccess={() => { setAdminOk(true) }} />

  const inputStyle: React.CSSProperties = { padding: '10px 14px', borderRadius: 8, border: '1.5px solid #2a2a2a', background: '#111', color: '#fff', fontSize: 14, outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
  const labelStyle: React.CSSProperties = { fontSize: 12, color: '#666', marginBottom: 4, display: 'block', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError(null)
    setShowForm(true)
  }

  const openEdit = (m: AdminModel) => {
    setEditing(m)
    setForm({
      slug: m.slug, name: m.name, avatarUrl: m.avatarUrl, coverUrl: m.coverUrl,
      bio: m.bio ?? '', followerCount: m.followerCount, likeCount: m.likeCount,
      photoCount: m.photoCount ?? 0, videoCount: m.videoCount, viewerCount: m.viewerCount ?? 0,
      isVerified: m.isVerified, isOnline: m.isOnline, isFeatured: m.isFeatured ?? false,
      tags: (m.tags ?? []).join(', '),
      photos: m.photos ?? [],
    })
    setError(null)
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.slug.trim() || !form.name.trim()) { setError('Slug and name are required'); return }
    setSaving(true); setError(null)
    try {
      const payload = {
        ...form,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        photos: form.photos,
        photoCount: form.photos.length || form.photoCount,
      }
      if (editing) {
        const updated = await adminFetch(`/admin/models/${editing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        setModels(ms => ms.map(m => m.id === editing.id ? updated : m))
      } else {
        const created = await adminFetch('/admin/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        setModels(ms => [created, ...ms])
      }
      setShowForm(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete модель?')) return
    try {
      await adminFetch(`/admin/models/${id}`, { method: 'DELETE' })
      setModels(ms => ms.filter(m => m.id !== id))
    } catch (e: any) {
      alert('Delete failed: ' + e.message)
    }
  }

  // ─── Subdomain handlers ───
  const openCreateSub = () => {
    setEditingSub(null)
    setSubForm({ slug: '', modelId: 0, customTitle: '', customDescription: '', customColor: '', isActive: true })
    setSubError(null)
    setShowSubForm(true)
  }
  const openEditSub = (s: Subdomain) => {
    setEditingSub(s)
    setSubForm({ slug: s.slug, modelId: s.modelId, customTitle: s.customTitle, customDescription: s.customDescription ?? '', customColor: s.customColor ?? '', isActive: s.isActive })
    setSubError(null)
    setShowSubForm(true)
  }
  const handleSaveSub = async () => {
    if (!subForm.slug.trim() || !subForm.customTitle.trim()) { setSubError('Slug and title are required'); return }
    setSavingSub(true); setSubError(null)
    try {
      if (editingSub) {
        const updated = await adminFetch(`/admin/subdomains/${editingSub.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subForm) })
        setSubdomains(ss => ss.map(s => s.id === editingSub.id ? updated : s))
      } else {
        const created = await adminFetch('/admin/subdomains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subForm) })
        setSubdomains(ss => [created, ...ss])
      }
      setShowSubForm(false)
    } catch (e: any) {
      setSubError(e.message)
    } finally {
      setSavingSub(false)
    }
  }
  const handleDeleteSub = async (id: number) => {
    if (!confirm('Delete субдомен?')) return
    try {
      await adminFetch(`/admin/subdomains/${id}`, { method: 'DELETE' })
      setSubdomains(ss => ss.filter(s => s.id !== id))
    } catch (e: any) {
      alert('Delete failed: ' + e.message)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <style>{`@keyframes admin-spin { to { transform: rotate(360deg) } }`}</style>
      {/* Header */}
      <div style={{ background: '#111', borderBottom: '1px solid #1e1e1e', padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: '#2AABEE' }}>⚡ Fansly Admin</div>
        </div>
        <button onClick={async () => { await adminFetch('/admin/logout-admin', { method: 'POST' }); setAdminOk(false) }}
          style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #333', background: 'transparent', color: '#888', fontSize: 13, cursor: 'pointer' }}>
          Sign out
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '20px 24px' }}>
          {([
            { Icon: IcoUser,  label: 'Users', val: stats.totalUsers },
            { Icon: IcoStar,  label: 'Creators',        val: stats.totalModels },
            { Icon: IcoGlobe, label: 'Subdomains',     val: stats.totalSubdomains },
            { Icon: IcoChat,  label: 'Messages',     val: stats.totalMessages },
          ] as const).map(({ Icon, label, val }) => (
            <div key={label} style={{ background: '#161616', borderRadius: 12, padding: '16px 20px', border: '1px solid #1e1e1e' }}>
              <div style={{ fontSize: 12, color: '#555', marginBottom: 4, display: 'flex', alignItems: 'center' }}><Icon />{label}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#fff' }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, padding: '0 24px', borderBottom: '1px solid #1e1e1e' }}>
        {([
          { key: 'models',     Icon: IcoStar,  label: 'Creators' },
          { key: 'subdomains', Icon: IcoGlobe, label: 'Subdomains' },
        ] as const).map(({ key, Icon, label }) => (
          <button key={key} onClick={() => setTab(key as any)}
            style={{ padding: '12px 20px', border: 'none', background: 'transparent', color: tab === key ? '#2AABEE' : '#555', fontWeight: tab === key ? 700 : 400, fontSize: 14, cursor: 'pointer', borderBottom: tab === key ? '2px solid #2AABEE' : '2px solid transparent', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center' }}>
            <Icon />{label}
          </button>
        ))}
      </div>

      {/* ── MODELS TAB ── */}
      {tab === 'models' && (
        <div style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Creators ({models.length})</h2>
            <button onClick={openCreate}
              style={{ padding: '9px 20px', borderRadius: 10, border: 'none', background: '#2AABEE', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
              + Add
            </button>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {models.map(m => (
              <div key={m.id} style={{ background: '#161616', borderRadius: 12, padding: '14px 18px', border: '1px solid #1e1e1e', display: 'flex', alignItems: 'center', gap: 14 }}>
                <img src={m.avatarUrl} alt="" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', background: '#222', flexShrink: 0 }} onError={e => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="%23333"/></svg>' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{m.name}</div>
                  <div style={{ color: '#555', fontSize: 12 }}>/{m.slug} · {m.followerCount.toLocaleString()} followers · {(m.photos ?? []).length} photos</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {m.isVerified && (
                    <span style={{ fontSize: 11, background: '#1a3a4a', color: '#2AABEE', padding: '2px 8px', borderRadius: 20, display: 'inline-flex', alignItems: 'center' }}>
                      <IcoCheck />Verified
                    </span>
                  )}
                  {m.isOnline && (
                    <span style={{ fontSize: 11, background: '#1a3a1a', color: '#4ade80', padding: '2px 8px', borderRadius: 20, display: 'inline-flex', alignItems: 'center' }}>
                      <IcoDot color="#4ade80" />Online
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => openEdit(m)} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #2a2a2a', background: 'transparent', color: '#aaa', fontSize: 13, cursor: 'pointer' }}>Edit</button>
                  <button onClick={() => handleDelete(m.id)} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #3a1a1a', background: 'transparent', color: '#e05555', fontSize: 13, cursor: 'pointer' }}>Delete</button>
                </div>
              </div>
            ))}
            {!models.length && <div style={{ color: '#444', textAlign: 'center', padding: '40px 0' }}>No creators yet</div>}
          </div>
        </div>
      )}

      {/* ── SUBDOMAINS TAB ── */}
      {tab === 'subdomains' && (
        <div style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Subdomains ({subdomains.length})</h2>
            <button onClick={openCreateSub}
              style={{ padding: '9px 20px', borderRadius: 10, border: 'none', background: '#2AABEE', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
              + Add
            </button>
          </div>

          <div style={{ background: '#161616', borderRadius: 12, border: '1px solid #1e1e1e', padding: '14px 18px', marginBottom: 14, fontSize: 13, color: '#666', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <IcoLightbulb />
            Create a subdomain and configure it in DNS as a CNAME pointing to the platform domain. Nginx will handle requests automatically.
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {subdomains.map(s => (
              <div key={s.id} style={{ background: '#161616', borderRadius: 12, padding: '14px 18px', border: '1px solid #1e1e1e', display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{s.slug}</div>
                  <div style={{ color: '#555', fontSize: 12 }}>{s.customTitle} · modelId={s.modelId}</div>
                </div>
                <span style={{ fontSize: 11, background: s.isActive ? '#1a3a1a' : '#2a1a1a', color: s.isActive ? '#4ade80' : '#e05555', padding: '2px 8px', borderRadius: 20, display: 'inline-flex', alignItems: 'center' }}>
                  <IcoDot color={s.isActive ? '#4ade80' : '#e05555'} />{s.isActive ? 'Active' : 'Off'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => openEditSub(s)} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #2a2a2a', background: 'transparent', color: '#aaa', fontSize: 13, cursor: 'pointer' }}>Edit</button>
                  <button onClick={() => handleDeleteSub(s.id)} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #3a1a1a', background: 'transparent', color: '#e05555', fontSize: 13, cursor: 'pointer' }}>Delete</button>
                </div>
              </div>
            ))}
            {!subdomains.length && <div style={{ color: '#444', textAlign: 'center', padding: '40px 0' }}>No subdomains yet</div>}
          </div>
        </div>
      )}

      {/* ── MODEL FORM MODAL ── */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16, overflowY: 'auto' }}
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false) }}>
          <div style={{ background: '#161616', borderRadius: 20, padding: '28px 28px', width: '100%', maxWidth: 560, border: '1px solid #222', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 800 }}>{editing ? 'Edit creator' : 'Add creator'}</h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Basic fields */}
              {[['slug', 'Slug (URL)', 'url-slug'], ['name', 'Name', 'Creator name']].map(([field, lbl, ph]) => (
                <div key={field}>
                  <label style={labelStyle}>{lbl}</label>
                  <input style={inputStyle} placeholder={ph} value={(form as any)[field]}
                    onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} />
                </div>
              ))}

              {/* Avatar with upload */}
              <div>
                <label style={labelStyle}>Avatar</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input style={{ ...inputStyle, flex: 1, minWidth: 160 }} placeholder="Avatar URL" value={form.avatarUrl}
                    onChange={e => setForm(f => ({ ...f, avatarUrl: e.target.value }))} />
                  <UploadButton label="Upload" uploading={uploading} setUploading={setUploading}
                    onUpload={urls => { if (urls[0]) setForm(f => ({ ...f, avatarUrl: urls[0] })) }} />
                </div>
                {form.avatarUrl && <img src={form.avatarUrl} alt="" style={{ marginTop: 8, width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', background: '#222' }} />}
              </div>

              {/* Cover with upload */}
              <div>
                <label style={labelStyle}>Cover</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input style={{ ...inputStyle, flex: 1, minWidth: 160 }} placeholder="Cover URL" value={form.coverUrl}
                    onChange={e => setForm(f => ({ ...f, coverUrl: e.target.value }))} />
                  <UploadButton label="Upload" uploading={uploading} setUploading={setUploading}
                    onUpload={urls => { if (urls[0]) setForm(f => ({ ...f, coverUrl: urls[0] })) }} />
                </div>
                {form.coverUrl && <img src={form.coverUrl} alt="" style={{ marginTop: 8, width: '100%', height: 80, objectFit: 'cover', borderRadius: 8, background: '#222' }} />}
              </div>

              {/* Gallery — multi-upload */}
              <div>
                <label style={labelStyle}>Галерея photos ({form.photos.length} шт.)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <UploadButton label="Добавить photos (можно много)" multiple uploading={uploading} setUploading={setUploading}
                    onUpload={urls => setForm(f => ({ ...f, photos: [...f.photos, ...urls] }))} />
                  {form.photos.length > 0 && (
                    <button type="button" onClick={() => setForm(f => ({ ...f, photos: [] }))}
                      style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #3a1a1a', background: 'transparent', color: '#e05555', fontSize: 12, cursor: 'pointer' }}>
                      Clear all
                    </button>
                  )}
                </div>
                <PhotoGrid photos={form.photos} onRemove={url => setForm(f => ({ ...f, photos: f.photos.filter(p => p !== url) }))} />
              </div>

              {/* Bio */}
              <div>
                <label style={labelStyle}>Biography</label>
                <textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} value={form.bio}
                  onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} />
              </div>

              {/* Number fields */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[['followerCount', 'Followers'], ['likeCount', 'Likes'], ['videoCount', 'Videos'], ['viewerCount', 'Viewers']].map(([field, lbl]) => (
                  <div key={field}>
                    <label style={labelStyle}>{lbl}</label>
                    <input type="number" style={inputStyle} value={(form as any)[field]}
                      onChange={e => setForm(f => ({ ...f, [field]: parseInt(e.target.value) || 0 }))} />
                  </div>
                ))}
              </div>

              {/* Tags */}
              <div>
                <label style={labelStyle}>Tags (comma-separated)</label>
                <input style={inputStyle} value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
              </div>

              {/* Checkboxes */}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {([['isVerified', 'Verified'], ['isOnline', 'Online'], ['isFeatured', 'Featured']] as const).map(([field, lbl]) => (
                  <label key={field} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: '#aaa', fontSize: 13 }}>
                    <input type="checkbox" checked={Boolean(form[field])}
                      onChange={e => setForm(f => ({ ...f, [field]: e.target.checked }))}
                      style={{ width: 16, height: 16, accentColor: '#2AABEE' }} />
                    {lbl}
                  </label>
                ))}
              </div>

              {error && <div style={{ background: '#2a0a0a', borderRadius: 8, padding: '10px 14px', color: '#e05555', fontSize: 13 }}>{error}</div>}

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
                <button onClick={() => setShowForm(false)}
                  style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #2a2a2a', background: 'transparent', color: '#666', fontSize: 13, cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving || uploading}
                  style={{ padding: '9px 24px', borderRadius: 8, border: 'none', background: saving ? '#444' : '#2AABEE', color: '#fff', fontWeight: 700, fontSize: 13, cursor: saving ? 'default' : 'pointer' }}>
                  {saving ? 'Saving...' : editing ? 'Save' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── SUBDOMAIN FORM MODAL ── */}
      {showSubForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setShowSubForm(false) }}>
          <div style={{ background: '#161616', borderRadius: 20, padding: '28px', width: '100%', maxWidth: 460, border: '1px solid #222' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 800 }}>{editingSub ? 'Edit subdomain' : 'Add subdomain'}</h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelStyle}>Subdomain slug</label>
                <input style={inputStyle} placeholder="example → example.yourdomain.com" value={subForm.slug}
                  onChange={e => setSubForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} />
              </div>
              <div>
                <label style={labelStyle}>Creator ID</label>
                <select style={inputStyle} value={subForm.modelId} onChange={e => setSubForm(f => ({ ...f, modelId: parseInt(e.target.value) }))}>
                  <option value={0}>— select creator —</option>
                  {models.map(m => <option key={m.id} value={m.id}>{m.name} (/{m.slug})</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Page title</label>
                <input style={inputStyle} placeholder="Title" value={subForm.customTitle}
                  onChange={e => setSubForm(f => ({ ...f, customTitle: e.target.value }))} />
              </div>
              <div>
                <label style={labelStyle}>Description (SEO)</label>
                <input style={inputStyle} placeholder="Description" value={subForm.customDescription}
                  onChange={e => setSubForm(f => ({ ...f, customDescription: e.target.value }))} />
              </div>
              <div>
                <label style={labelStyle}>Color (#hex)</label>
                <input style={inputStyle} placeholder="#2AABEE" value={subForm.customColor}
                  onChange={e => setSubForm(f => ({ ...f, customColor: e.target.value }))} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: '#aaa', fontSize: 13 }}>
                <input type="checkbox" checked={subForm.isActive} onChange={e => setSubForm(f => ({ ...f, isActive: e.target.checked }))} style={{ width: 16, height: 16, accentColor: '#2AABEE' }} />
                Active
              </label>

              {subError && <div style={{ background: '#2a0a0a', borderRadius: 8, padding: '10px 14px', color: '#e05555', fontSize: 13 }}>{subError}</div>}

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowSubForm(false)}
                  style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #2a2a2a', background: 'transparent', color: '#666', fontSize: 13, cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={handleSaveSub} disabled={savingSub}
                  style={{ padding: '9px 24px', borderRadius: 8, border: 'none', background: savingSub ? '#444' : '#2AABEE', color: '#fff', fontWeight: 700, fontSize: 13, cursor: savingSub ? 'default' : 'pointer' }}>
                  {savingSub ? 'Saving...' : editingSub ? 'Save' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
