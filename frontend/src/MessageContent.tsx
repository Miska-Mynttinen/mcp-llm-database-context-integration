import MermaidBlock from './MermaidBlock'

type MessageContentProps = {
  content: string
}

const MERMAID_FENCE = /(```mermaid\s*[\s\S]*?```)/gi
const MERMAID_BODY = /^```mermaid\s*([\s\S]*?)```$/i

function MessageContent({ content }: MessageContentProps) {
  const sections = content.split(MERMAID_FENCE)

  return (
    <>
      {sections.map((section, index) => {
        const diagram = section.match(MERMAID_BODY)
        if (diagram) {
          const chart = diagram[1].trim()
          return <MermaidBlock chart={chart} key={`${index}:${chart}`} />
        }
        const text = section.trim()
        return text ? <p className="message-text" key={index}>{text}</p> : null
      })}
    </>
  )
}

export default MessageContent
