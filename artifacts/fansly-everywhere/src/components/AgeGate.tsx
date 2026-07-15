type Props = { onConfirm: () => void }

export default function AgeGate({ onConfirm }: Props) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(10,10,10,0.97)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '1rem',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{
        maxWidth: 480, width: '100%',
        background: '#111',
        borderRadius: 12,
        padding: '2.5rem 2.25rem 2rem',
        textAlign: 'center',
        border: '1px solid #1e1e1e',
      }}>
        {/* Fansly logo */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: '1.5rem' }}>
          <img
            src='/favicon.png'
            alt='Fansly'
            style={{ width: 40, height: 40, objectFit: 'contain', display: 'block' }}
          />
          <span style={{ fontSize: 24, fontWeight: 800, color: '#fff', letterSpacing: -0.5 }}>
            Fansly
          </span>
        </div>

        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: '0 0 1.25rem' }}>
          Possible Age Restricted Content
        </h2>

        <p style={{ color: '#aaa', fontSize: 13.5, lineHeight: 1.7, margin: '0 0 1rem', textAlign: 'left' }}>
          This website (Fansly) contains age-restricted content. If you are under the age of 18 years
          or under the age of majority in the location from where you are accessing this website, you do
          not have authorization or permission to enter this website or access any of its content. If you
          are over the age of 18 years or over the age of majority in the location from where you are
          accessing this website by entering the website you hereby agree to comply with the{' '}
          <a href='/terms' style={{ color: '#fff', fontWeight: 700, textDecoration: 'none' }}>
            Fansly Terms of Service
          </a>.
        </p>

        <p style={{ color: '#aaa', fontSize: 13.5, lineHeight: 1.7, margin: '0 0 1.75rem', textAlign: 'left' }}>
          By clicking on the "Enter" button, and by entering this website you agree with all the above
          and certify under penalty of perjury that you are above the age of 18 or the age of majority
          in your location, whichever is greater.
        </p>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={() => { window.location.href = 'https://google.com' }}
            style={{
              flex: 1, padding: '13px', borderRadius: 8,
              border: '1px solid #2a2a2a',
              background: '#1a1a1a', color: '#ccc',
              fontSize: 15, fontWeight: 600, cursor: 'pointer',
            }}
            onMouseOver={e => ((e.currentTarget as HTMLElement).style.background = '#222')}
            onMouseOut={e => ((e.currentTarget as HTMLElement).style.background = '#1a1a1a')}
          >
            Leave
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, padding: '13px', borderRadius: 8, border: 'none',
              background: '#22c55e', color: '#fff',
              fontSize: 15, fontWeight: 700, cursor: 'pointer',
            }}
            onMouseOver={e => ((e.currentTarget as HTMLElement).style.background = '#16a34a')}
            onMouseOut={e => ((e.currentTarget as HTMLElement).style.background = '#22c55e')}
          >
            Enter
          </button>
        </div>
      </div>
    </div>
  )
}
