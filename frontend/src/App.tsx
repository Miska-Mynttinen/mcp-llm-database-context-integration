import { useState } from 'react'
import MermaidBlock from './MermaidBlock'

function Answer({ content }: { content: string }) {
  const sections = content.split(/(```mermaid\s*[\s\S]*?```)/gi)

  return (
    <div className="answer">
      {sections.map((section, index) => {
        const diagram = section.match(/^```mermaid\s*([\s\S]*?)```$/i)
        if (diagram) {
          return <MermaidBlock chart={diagram[1].trim()} key={index} />
        }
        return section ? <p key={index}>{section}</p> : null
      })}
    </div>
  )
}

function App() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId] = useState(() => crypto.randomUUID())

  const ask = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userId: 'user1', message: question })
      })
      const data = await res.json()
      setAnswer(data.answer || data.error)
    } catch (error) {
      setAnswer('Error: ' + (error instanceof Error ? error.message : String(error)))
    }
    setLoading(false)
  }

  return (
    <div style={{ padding: '20px' }}>
      <h1>LLM Database Integration</h1>
      <input
        type="text"
        value={question}
        onChange={e => setQuestion(e.target.value)}
        placeholder="Ask a question about the database"
        style={{ width: '300px', marginRight: '10px' }}
      />
      <button onClick={ask} disabled={loading}>{loading ? 'Asking...' : 'Ask'}</button>
      <Answer content={answer} />
    </div>
  )
}

export default App