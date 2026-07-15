import { useState, useEffect, useCallback } from 'react'
import { Route, Switch, Redirect } from 'wouter'
import AgeGate from './components/AgeGate'
import CookieBanner from './components/CookieBanner'
import Nav from './components/Nav'
import ModelsPage from './pages/ModelsPage'
import ModelProfilePage from './pages/ModelProfilePage'
import ChatPage from './pages/ChatPage'
import AdminPage from './pages/AdminPage'
import { getMe, logout, type User } from './api'

export default function App() {
  const [ageConfirmed, setAgeConfirmed] = useState(() =>
    localStorage.getItem('age_confirmed') === '1'
  )
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)

  const checkAuth = useCallback(async () => {
    const me = await getMe()
    setUser(me)
    setAuthReady(true)
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  useEffect(() => {
    const handler = () => checkAuth()
    window.addEventListener('fan:auth-success', handler)
    return () => window.removeEventListener('fan:auth-success', handler)
  }, [checkAuth])

  if (!ageConfirmed) {
    return (
      <AgeGate
        onConfirm={() => {
          localStorage.setItem('age_confirmed', '1')
          setAgeConfirmed(true)
        }}
      />
    )
  }

  const handleLogout = async () => {
    await logout()
    setUser(null)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff' }}>
      <CookieBanner />
      <Nav user={user} onLogout={handleLogout} />
      <Switch>
        <Route path="/">
          {() => <ModelsPage user={user} authReady={authReady} />}
        </Route>
        <Route path="/model/:slug">
          {(params) => <ModelProfilePage slug={params.slug} user={user} />}
        </Route>
        <Route path="/chat/:slug">
          {(params) => <ChatPage slug={params.slug} user={user} />}
        </Route>
        <Route path="/admin">
          {() => <AdminPage user={user} authReady={authReady} />}
        </Route>
        {/* Short slug URL: /clarice → /model/clarice */}
        <Route path="/:slug">
          {(params) => <Redirect to={`/model/${params.slug}`} />}
        </Route>
        <Route>
          {() => <Redirect to="/model/stella-cardo" />}
        </Route>
      </Switch>
    </div>
  )
}
