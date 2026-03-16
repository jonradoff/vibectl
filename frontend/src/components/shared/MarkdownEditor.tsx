import { useState, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  label?: string
  required?: boolean
  error?: string
}

type ToolbarAction = {
  label: string
  icon: string
  prefix: string
  suffix?: string
  block?: boolean
}

const toolbarActions: ToolbarAction[] = [
  { label: 'Bold', icon: 'B', prefix: '**', suffix: '**' },
  { label: 'Italic', icon: 'I', prefix: '_', suffix: '_' },
  { label: 'Code', icon: '<>', prefix: '`', suffix: '`' },
  { label: 'Link', icon: '🔗', prefix: '[', suffix: '](url)' },
  { label: 'Bullet list', icon: '•', prefix: '- ', block: true },
  { label: 'Numbered list', icon: '1.', prefix: '1. ', block: true },
  { label: 'Heading', icon: 'H', prefix: '### ', block: true },
  { label: 'Code block', icon: '```', prefix: '```\n', suffix: '\n```', block: true },
]

export default function MarkdownEditor({
  value,
  onChange,
  placeholder,
  rows = 8,
  label,
  required,
  error,
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const applyAction = useCallback(
    (action: ToolbarAction) => {
      const ta = textareaRef.current
      if (!ta) return

      const start = ta.selectionStart
      const end = ta.selectionEnd
      const selected = value.slice(start, end)
      const before = value.slice(0, start)
      const after = value.slice(end)

      const prefix = action.prefix
      const suffix = action.suffix ?? ''

      if (action.block && !before.endsWith('\n') && before.length > 0) {
        const newValue = before + '\n' + prefix + (selected || 'text') + suffix + after
        onChange(newValue)
      } else {
        const newValue = before + prefix + (selected || 'text') + suffix + after
        onChange(newValue)
      }

      // Restore focus
      setTimeout(() => {
        ta.focus()
        const cursorPos = start + prefix.length + (selected || 'text').length
        ta.setSelectionRange(cursorPos, cursorPos)
      }, 0)
    },
    [value, onChange]
  )

  return (
    <div>
      {label && (
        <label className="mb-1 block text-sm font-medium text-gray-300">
          {label} {required && <span className="text-red-400">*</span>}
        </label>
      )}
      <div className="rounded-lg border border-gray-600 bg-gray-800 overflow-hidden focus-within:border-indigo-500 transition-colors">
        {/* Toolbar */}
        <div className="flex items-center gap-0.5 border-b border-gray-700 px-2 py-1 bg-gray-850">
          {/* Mode tabs */}
          <button
            type="button"
            onClick={() => setMode('write')}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              mode === 'write'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Write
          </button>
          <button
            type="button"
            onClick={() => setMode('preview')}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              mode === 'preview'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Preview
          </button>

          {mode === 'write' && (
            <>
              <span className="mx-1.5 h-4 w-px bg-gray-700" />
              {toolbarActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => applyAction(action)}
                  title={action.label}
                  className="rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-white transition-colors font-mono"
                >
                  {action.icon}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Content */}
        {mode === 'write' ? (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
            className="w-full resize-y bg-transparent px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none"
          />
        ) : (
          <div
            className="prose prose-invert prose-sm max-w-none px-3 py-2 min-h-[120px]"
            style={{ minHeight: `${rows * 1.5}rem` }}
          >
            {value ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            ) : (
              <p className="text-gray-600 italic">Nothing to preview</p>
            )}
          </div>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  )
}
