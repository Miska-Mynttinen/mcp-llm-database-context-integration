import { useState, type FormEvent } from 'react'
import { getErrorMessage, login, register, type AuthResult } from './api'

type Mode = 'login' | 'register'

type LoginFormProps = {
  onLogin: (result: AuthResult) => void
  /** Shown above the form, e.g. after a session expired. */
  notice?: string
}

// Mirrors the server rules in src/auth/credentials.ts.
const USERNAME_PATTERN = '[A-Za-z0-9_.\\-]{3,64}'
const USERNAME_HINT = '3–64 characters: letters, digits, dot, dash or underscore'
const MIN_PASSWORD_LENGTH = 8

const COPY: Record<Mode, { title: string; submit: string; busy: string; switchPrompt: string; switchAction: string }> = {
  login: {
    title: 'Log in',
    submit: 'Log in',
    busy: 'Logging in…',
    switchPrompt: 'No account yet?',
    switchAction: 'Create an account',
  },
  register: {
    title: 'Create an account',
    submit: 'Create account',
    busy: 'Creating account…',
    switchPrompt: 'Already have an account?',
    switchAction: 'Log in',
  },
}

function LoginForm({ onLogin, notice }: LoginFormProps) {
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const copy = COPY[mode]
  const isRegister = mode === 'register'

  const switchMode = () => {
    setMode(isRegister ? 'login' : 'register')
    setError(null)
    setPassword('')
    setConfirmPassword('')
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting) return
    if (isRegister && password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      const submit = isRegister ? register : login
      onLogin(await submit(username.trim(), password))
    } catch (err) {
      setError(getErrorMessage(err))
      setPassword('')
      setConfirmPassword('')
      setIsSubmitting(false)
    }
  }

  return (
    <main className="login">
      <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
        <p className="login-app-name">LLM Database Integration</p>
        <h1>{copy.title}</h1>
        {notice && !error && <p className="login-notice">{notice}</p>}
        {error && <p className="login-error" role="alert">{error}</p>}
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            pattern={isRegister ? USERNAME_PATTERN : undefined}
            title={isRegister ? USERNAME_HINT : undefined}
            aria-describedby={isRegister ? 'username-hint' : undefined}
            required
            autoFocus
          />
        </label>
        {isRegister && <p className="login-hint" id="username-hint">{USERNAME_HINT}</p>}
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            minLength={isRegister ? MIN_PASSWORD_LENGTH : undefined}
            required
          />
        </label>
        {isRegister && (
          <label>
            Confirm password
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
        )}
        <button type="submit" disabled={isSubmitting}>{isSubmitting ? copy.busy : copy.submit}</button>
        <p className="login-switch">
          {copy.switchPrompt}{' '}
          <button type="button" className="button-link" onClick={switchMode} disabled={isSubmitting}>
            {copy.switchAction}
          </button>
        </p>
      </form>
    </main>
  )
}

export default LoginForm
