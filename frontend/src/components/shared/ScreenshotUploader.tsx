import { useState, useRef } from 'react'
import { uploadFiles } from '../../api/client'
import type { Attachment } from '../../types'

interface ScreenshotUploaderProps {
  attachments: Attachment[]
  onChange: (attachments: Attachment[]) => void
}

export default function ScreenshotUploader({ attachments, onChange }: ScreenshotUploaderProps) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = async (files: FileList | File[]) => {
    const fileArr = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (fileArr.length === 0) {
      setError('Only image files are allowed')
      return
    }

    setError(null)
    setUploading(true)
    try {
      const uploaded = await uploadFiles(fileArr)
      onChange([...attachments, ...uploaded])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean) as File[]
    if (files.length > 0) {
      e.preventDefault()
      handleFiles(files)
    }
  }

  const removeAttachment = (id: string) => {
    onChange(attachments.filter((a) => a.id !== id))
  }

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-300">Screenshots</label>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onPaste={handlePaste}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
          dragOver
            ? 'border-indigo-500 bg-indigo-500/10'
            : 'border-gray-600 hover:border-gray-500 bg-gray-800/50'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
        {uploading ? (
          <div className="flex items-center justify-center gap-2 text-gray-400">
            <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Uploading...</span>
          </div>
        ) : (
          <div className="text-gray-400">
            <svg className="mx-auto h-8 w-8 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M6.75 7.5a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18 9.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
            </svg>
            <p className="text-sm">Drop images here, paste from clipboard, or click to browse</p>
            <p className="text-xs text-gray-500 mt-0.5">PNG, JPG, GIF up to 10MB each</p>
          </div>
        )}
      </div>

      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}

      {/* Thumbnails */}
      {attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {attachments.map((att) => (
            <div key={att.id} className="group relative">
              <img
                src={att.url}
                alt={att.filename}
                className="h-20 w-20 rounded-lg border border-gray-700 object-cover"
              />
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                className="absolute -right-1.5 -top-1.5 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white text-xs hover:bg-red-500"
              >
                &times;
              </button>
              <p className="mt-0.5 max-w-[80px] truncate text-[10px] text-gray-500">{att.filename}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
