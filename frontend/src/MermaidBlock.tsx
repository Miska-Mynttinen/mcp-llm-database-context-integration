import { useEffect, useRef, useState } from 'react'
import type { Mermaid } from 'mermaid'

type MermaidBlockProps = {
  chart: string
}

let renderCounter = 0
let mermaidPromise: Promise<Mermaid> | null = null

// Loaded on first diagram so mermaid stays out of the initial bundle.
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
          // Throw on invalid syntax instead of injecting an error SVG into <body>.
          suppressErrorRendering: true,
        })
        return mermaid
      })
      .catch((loadError: unknown) => {
        mermaidPromise = null
        throw loadError
      })
  }
  return mermaidPromise
}

function MermaidBlock({ chart }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const elementId = `mermaid-chart-${renderCounter++}`

    loadMermaid()
      .then(mermaid => mermaid.render(elementId, chart))
      .then(({ svg }) => {
        if (!active || !containerRef.current) return
        containerRef.current.innerHTML = svg
        setError(null)
      })
      .catch((renderError: unknown) => {
        if (!active) return
        if (containerRef.current) containerRef.current.innerHTML = ''
        setError(renderError instanceof Error ? renderError.message : 'Unable to render diagram')
      })

    return () => {
      active = false
    }
  }, [chart])

  return (
    <>
      <div className="mermaid-block" ref={containerRef} role="img" aria-label="Mermaid diagram" />
      {error && (
        <details className="mermaid-error">
          <summary>Diagram could not be rendered</summary>
          <pre>{chart}</pre>
          <small>{error}</small>
        </details>
      )}
    </>
  )
}

export default MermaidBlock
