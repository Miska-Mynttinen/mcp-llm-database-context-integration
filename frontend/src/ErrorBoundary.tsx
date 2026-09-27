import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  hasError: boolean
}

// Without this, an unexpected render error unmounts the whole app and leaves a blank page.
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unexpected UI error:', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }
    return (
      <main className="login">
        <div className="login-form" role="alert">
          <p className="login-app-name">LLM Database Integration</p>
          <h1>Something went wrong</h1>
          <p>The page hit an unexpected error. Reloading usually fixes it; your conversation is kept on the server.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </main>
    )
  }
}

export default ErrorBoundary
