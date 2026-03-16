import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFeedback } from '../../api/client';

interface FeedbackFormProps {
  open: boolean;
  onClose: () => void;
  projects: { id: string; name: string; code: string }[];
}

export default function FeedbackForm({ open, onClose, projects }: FeedbackFormProps) {
  const queryClient = useQueryClient();

  const [projectId, setProjectId] = useState('');
  const [sourceType, setSourceType] = useState('manual');
  const [rawContent, setRawContent] = useState('');
  const [submittedBy, setSubmittedBy] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [success, setSuccess] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      createFeedback({
        ...(projectId ? { projectId } : {}),
        sourceType,
        rawContent,
        ...(submittedBy ? { submittedBy } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback'] });
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] });
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        resetForm();
        onClose();
      }, 1200);
    },
  });

  function resetForm() {
    setProjectId('');
    setSourceType('manual');
    setRawContent('');
    setSubmittedBy('');
    setSourceUrl('');
    mutation.reset();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!rawContent.trim()) return;
    mutation.mutate();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg bg-gray-800 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-700 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-100">Submit Feedback</h2>
          <button
            onClick={() => { resetForm(); onClose(); }}
            className="text-gray-400 hover:text-gray-200"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          {/* Project */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none"
            >
              <option value="">Unassigned</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </select>
          </div>

          {/* Source Type */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Source Type</label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none"
            >
              <option value="manual">Manual</option>
              <option value="web_form">Web Form</option>
              <option value="email">Email</option>
              <option value="github_comment">GitHub Comment</option>
              <option value="other">Other</option>
            </select>
          </div>

          {/* Feedback Content */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">
              Feedback Content <span className="text-red-400">*</span>
            </label>
            <textarea
              value={rawContent}
              onChange={(e) => setRawContent(e.target.value)}
              rows={4}
              required
              placeholder="Describe the feedback..."
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Name / Handle */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Your Name / Handle</label>
            <input
              type="text"
              value={submittedBy}
              onChange={(e) => setSubmittedBy(e.target.value)}
              placeholder="Optional"
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Source URL */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Source URL</label>
            <input
              type="text"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="Optional — link to original source"
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Error */}
          {mutation.isError && (
            <p className="text-sm text-red-400">
              {mutation.error instanceof Error ? mutation.error.message : 'Something went wrong'}
            </p>
          )}

          {/* Success */}
          {success && (
            <p className="text-sm text-green-400">Feedback submitted successfully.</p>
          )}

          {/* Footer */}
          <div className="flex justify-end gap-3 border-t border-gray-700 pt-4">
            <button
              type="button"
              onClick={() => { resetForm(); onClose(); }}
              className="rounded border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !rawContent.trim()}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {mutation.isPending ? 'Submitting...' : 'Submit Feedback'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
