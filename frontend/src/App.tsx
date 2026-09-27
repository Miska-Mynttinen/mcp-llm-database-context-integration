import { useCallback, useState } from 'react'
import ChatView from './ChatView'
import LoginForm from './LoginForm'
import type { AuthResult } from './api'
import { loginStore } from './login'

const SESSION_EXPIRED_NOTICE = 'Your login has expired. Please log in again.'

function App() {
  const [currentLogin, setCurrentLogin] = useState(() => loginStore.current())
  const [notice, setNotice] = useState<string | undefined>()

  const handleLogin = ({ token, user }: AuthResult) => {
    setNotice(undefined)
    setCurrentLogin(loginStore.begin({ token, username: user.username }))
  }

  const endLogin = useCallback((message?: string) => {
    loginStore.end()
    setNotice(message)
    setCurrentLogin(null)
  }, [])

  const handleLogout = useCallback(() => endLogin(), [endLogin])
  const handleSessionExpired = useCallback(() => endLogin(SESSION_EXPIRED_NOTICE), [endLogin])

  if (!currentLogin) {
    return <LoginForm onLogin={handleLogin} notice={notice} />
  }
  // Keyed by token so a new login starts with freshly loaded history.
  return (
    <ChatView
      key={currentLogin.token}
      login={currentLogin}
      onLogout={handleLogout}
      onSessionExpired={handleSessionExpired}
    />
  )
}

export default App
