export type Model = {
  id: number
  slug: string
  name: string
  coverUrl: string
  avatarUrl: string
  bio: string | null
  isVerified: boolean
  followerCount: number
  likeCount: number
  photoCount: number | null
  videoCount: number
  isOnline: boolean
  viewerCount: number | null
  tags: string[]
  photos: string[]
  isFeatured?: boolean
  createdAt: string
}

export type User = {
  id: number
  telegramId: string
  firstName: string
  username: string | null
  role: 'user' | 'admin'
  avatarUrl: string | null
}

export async function getModels(params?: { page?: number; limit?: number; search?: string }) {
  const q = new URLSearchParams()
  if (params?.page) q.set('page', String(params.page))
  if (params?.limit) q.set('limit', String(params.limit))
  if (params?.search) q.set('search', params.search)
  const r = await fetch(`/api/models?${q}`, { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to fetch models')
  return r.json() as Promise<{ items: Model[]; total: number; page: number; limit: number }>
}

export async function getModel(slug: string): Promise<Model | null> {
  const r = await fetch(`/api/models/${slug}`, { credentials: 'include' })
  if (r.status === 404) return null
  if (!r.ok) return null
  return r.json()
}

export async function getMe(): Promise<User | null> {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' })
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
}

export type Message = {
  id: number
  modelSlug: string
  content: string
  fromUser: boolean
  createdAt: string
}

export async function getMessages(modelSlug: string): Promise<Message[] | null> {
  try {
    const r = await fetch(`/api/chat/${modelSlug}/messages`, { credentials: 'include' })
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

export async function sendMessage(modelSlug: string, content: string): Promise<Message[]> {
  const r = await fetch(`/api/chat/${modelSlug}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!r.ok) throw new Error('Failed to send message')
  return r.json()
}
