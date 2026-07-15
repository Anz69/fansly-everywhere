import { useState, useEffect, useRef } from 'react'
import { Link } from 'wouter'
import { getModel, getMessages, sendMessage, type Model, type Message, type User } from '../api'

type Props = { slug: string; user: User | null }

export default function ChatPage({ slug, user }: Props) {
  const [model, setModel]       = useState<Model | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput]       = useState('')
  const [sending, setSending]   = useState(false)
  const bottomRef               = useRef<HTMLDivElement>(null)
  const mountedRef              = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    getModel(slug).then(m => { if (m && mountedRef.current) setModel(m) })
  }, [slug])

  useEffect(() => {
    if (!user) return
    getMessages(slug).then(msgs => {
      if (msgs && mountedRef.current) setMessages(msgs)
    })
  }, [slug, user])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Not logged in
  if (!user) {
    return (
      <div style={{ textAlign: 'center', padding: '6rem 1.5rem' }}>
        <p style={{ color: '#888', marginBottom: '1.5rem', fontSize: 15 }}>
          Sign in to chat with models
        </p>
        <button
          onClick={() => (window as any).showTelegramAuth?.()}
          style={{
            padding: '12px 32px',
            borderRadius: 12,
            border: 'none',
            background: '#2AABEE',
            color: '#fff',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: 15,
          }}
        >
          Sign in via Telegram
        </button>
      </div>
    )
  }

  const handleSend = async () => {
    if (!input.trim() || sending) return
    const text = input.trim()
    setSending(true)
    setInput('')
    try {
      const msgs = await sendMessage(slug, text)
      if (!mountedRef.current) return
      // Server returns [userMsg, botMsg] — append both immediately
      setMessages(prev => [...prev, ...msgs])
    } catch {
      if (mountedRef.current) {
        setInput(text)
      }
    } finally {
      if (mountedRef.current) setSending(false)
    }
  }

  return (
    <div style={{
      maxWidth: 680,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      height: 'calc(100vh - 60px)',
    }}>
      {/* Chat header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0.875rem 1.5rem',
        borderBottom: '1px solid #1a1a1a',
        background: '#0a0a0a',
        flexShrink: 0,
      }}>
        {model ? (
          <Link href={`/model/${slug}`}>
            <a style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
              <div style={{ position: 'relative' }}>
                <img
                  src={model.avatarUrl}
                  alt={model.name}
                  style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }}
                />
                {model.isOnline && (
                  <span style={{
                    position: 'absolute',
                    bottom: 1,
                    right: 1,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: '#22c55e',
                    border: '2px solid #0a0a0a',
                  }} />
                )}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{model.name}</div>
                <div style={{ fontSize: 11, color: '#555' }}>
                  {model.isOnline ? 'Online' : 'Offline'}
                </div>
              </div>
            </a>
          </Link>
        ) : (
          <span style={{ color: '#555', fontSize: 14 }}>{slug}</span>
        )}
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1.25rem 1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#444', padding: '4rem', fontSize: 14 }}>
            Start the conversation...
          </div>
        )}
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              justifyContent: msg.fromUser ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{ maxWidth: '72%' }}>
              <div style={{
                padding: '10px 14px',
                borderRadius: msg.fromUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                background: msg.fromUser ? '#2AABEE' : '#1e1e1e',
                fontSize: 14,
                lineHeight: 1.55,
                color: '#fff',
              }}>
                {msg.content}
              </div>
              <div style={{
                fontSize: 11,
                color: '#444',
                marginTop: 3,
                textAlign: msg.fromUser ? 'right' : 'left',
                paddingInline: 4,
              }}>
                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              padding: '10px 14px',
              borderRadius: '18px 18px 18px 4px',
              background: '#1e1e1e',
              fontSize: 14,
              color: '#555',
            }}>
              ...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '1rem 1.5rem',
        borderTop: '1px solid #1a1a1a',
        display: 'flex',
        gap: 8,
        background: '#0a0a0a',
        flexShrink: 0,
      }}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          placeholder="Message..."
          disabled={sending}
          style={{
            flex: 1,
            padding: '11px 16px',
            borderRadius: 12,
            border: '1px solid #2a2a2a',
            background: '#141414',
            color: '#fff',
            fontSize: 14,
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          style={{
            padding: '11px 20px',
            borderRadius: 12,
            border: 'none',
            background: '#2AABEE',
            color: '#fff',
            fontWeight: 700,
            cursor: sending || !input.trim() ? 'not-allowed' : 'pointer',
            opacity: sending || !input.trim() ? 0.4 : 1,
            fontSize: 14,
            transition: 'opacity .15s',
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
