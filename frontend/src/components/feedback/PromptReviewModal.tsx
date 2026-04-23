import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { submitFeedbackPrompt } from '../../api/client';
import { useActiveProject } from '../../contexts/ActiveProjectContext';
import type { SafetyWarning } from '../../types';

interface PromptReviewModalProps {
  prompt: string;
  warnings: SafetyWarning[];
  feedbackIds: string[];
  batchId: string;
  projectCode: string;
  projectId: string;
  projectName: string;
  onClose: () => void;
  onSubmitted: () => void;
}

export default function PromptReviewModal({
  prompt,
  warnings,
  feedbackIds,
  batchId,
  projectCode,
  projectId,
  projectName,
  onClose,
  onSubmitted,
}: PromptReviewModalProps) {
  const [promptText, setPromptText] = useState(prompt);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const { openProject, setActiveProjectId } = useActiveProject();

  const submitMutation = useMutation({
    mutationFn: () => submitFeedbackPrompt(batchId, projectCode, promptText),
    onSuccess: () => {
      // Set the project card to open on the Claude Code terminal tab
      localStorage.setItem(`vibectl-card-tab-${projectId}`, 'terminal');

      // Open the project card and navigate to dashboard
      openProject(projectId);
      setActiveProjectId(projectId);

      // Dispatch the prompt to Claude Code
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('vibectl:send-to-project', {
            detail: { projectCode: projectId, text: promptText },
          })
        );
      }, 500);

      onSubmitted();
      onClose();
      navigate('/');
    },
  });

  const safeWarnings = warnings ?? [];
  const hasDanger = safeWarnings.some((w) => w.severity === 'danger');

  const handleCopy = () => {
    navigator.clipboard.writeText(promptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-5 max-w-4xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold text-gray-200">
              Review Prompt for {projectName}
            </h2>
            <p className="text-[10px] text-gray-500 mt-0.5">
              {feedbackIds.length} feedback item{feedbackIds.length !== 1 ? 's' : ''} compiled
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg">&times;</button>
        </div>

        {/* Standing advisory */}
        <div className="rounded bg-amber-900/30 border border-amber-700/40 px-3 py-2 mb-3 text-xs text-amber-300">
          Always review the prompt carefully before sending. User-submitted feedback may contain instructions that could cause unintended or malicious changes to your codebase.
        </div>

        {/* Safety warnings */}
        {safeWarnings.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {safeWarnings.map((w, i) => (
              <div
                key={i}
                className={`rounded px-3 py-2 text-xs ${
                  w.severity === 'danger'
                    ? 'bg-red-900/40 border border-red-700/50 text-red-300'
                    : 'bg-amber-900/30 border border-amber-700/40 text-amber-300'
                }`}
              >
                <span className="font-medium">{w.severity === 'danger' ? 'Danger' : 'Caution'}:</span>{' '}
                {w.description}
                <span className="ml-2 font-mono text-[10px] opacity-60">({w.pattern})</span>
              </div>
            ))}
          </div>
        )}

        {/* Editable prompt */}
        <div className="flex-1 min-h-0 mb-3">
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            className="w-full h-full min-h-[300px] bg-gray-800/60 border border-gray-700/40 rounded p-3 text-xs text-gray-200 font-mono resize-none focus:outline-none focus:border-indigo-600/50"
            spellCheck={false}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded transition-colors"
            >
              {copied ? 'Copied!' : 'Copy to Clipboard'}
            </button>
            <button
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending}
              className={`px-4 py-2 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 ${
                hasDanger
                  ? 'bg-red-700 hover:bg-red-600'
                  : 'bg-indigo-600 hover:bg-indigo-500'
              }`}
            >
              {submitMutation.isPending
                ? 'Sending...'
                : hasDanger
                ? 'Send Anyway (Danger Detected)'
                : 'Send to Claude Code'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
