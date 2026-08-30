import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

type MermaidBlockProps = {
  chart: string
}

let renderCounter = 0

function MermaidBlock({ chart }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const elementId = `mermaid-chart-${renderCounter++}`

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
    })

    mermaid.render(elementId, chart)
      .then(({ svg }) => {
        if (active && containerRef.current) {
          containerRef.current.innerHTML = svg
          setError(null)
        }
      })
      .catch((renderError: unknown) => {
        if (active) {
          setError(renderError instanceof Error ? renderError.message : 'Unable to render diagram')
        }
      })

    return () => {
      active = false
    }
  }, [chart])

  if (error) {
    return (
      <details className="mermaid-error">
        <summary>Diagram could not be rendered</summary>
        <pre>{chart}</pre>
        <small>{error}</small>
      </details>
    )
  }

  return <div className="mermaid-block" ref={containerRef} aria-label="Mermaid diagram" />
}

export default MermaidBlock
