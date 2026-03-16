import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { createIssue, getProjectByCode } from '../api/client';
import type { IssueType, Priority, Issue, Attachment } from '../types';
import { priorityColors, typeColors } from '../types';
import MarkdownEditor from '../components/shared/MarkdownEditor';
import ScreenshotUploader from '../components/shared/ScreenshotUploader';

const issueTypes: { value: IssueType; label: string; desc: string }[] = [
  { value: 'bug', label: 'Bug', desc: 'Something is broken' },
  { value: 'feature', label: 'Feature', desc: 'New functionality' },
  { value: 'idea', label: 'Idea', desc: 'Suggestion or concept' },
];

const priorities: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];

function IssueFormPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [type, setType] = useState<IssueType | ''>('');
  const [priority, setPriority] = useState<Priority | null>(null);
  const [description, setDescription] = useState('');
  const [reproSteps, setReproSteps] = useState('');
  const [source, setSource] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const {
    data: project,
    isLoading: projectLoading,
    error: projectError,
  } = useQuery({
    queryKey: ['project-by-code', code],
    queryFn: () => getProjectByCode(code!),
    enabled: !!code,
  });

  const mutation = useMutation({
    mutationFn: (data: Partial<Issue>) => createIssue(project!.id, data),
    onSuccess: (newIssue) => {
      navigate(`/projects/${code}/issues/${newIssue.issueKey}`);
    },
  });

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Title is required';
    if (!type) errs.type = 'Type is required';
    if (!priority) errs.priority = 'Priority is required';
    if (type === 'bug' && !reproSteps.trim())
      errs.reproSteps = 'Repro steps are required for bugs';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate() || !project) return;

    const data: Partial<Issue> = {
      title: title.trim(),
      type: type as IssueType,
      priority: priority!,
      description: description.trim(),
      createdBy: createdBy.trim() || 'unknown',
      ...(source.trim() && { source: source.trim() }),
      ...(dueDate && { dueDate }),
      ...(type === 'bug' && reproSteps.trim() && { reproSteps: reproSteps.trim() }),
      ...(attachments.length > 0 && { attachments }),
    };

    mutation.mutate(data);
  };

  if (projectLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <p className="text-gray-400">Loading project...</p>
      </div>
    );
  }

  if (projectError || !project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <p className="text-red-400">
          {projectError instanceof Error ? projectError.message : 'Project not found'}
        </p>
      </div>
    );
  }

  const inputClass =
    'w-full rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 outline-none focus:border-indigo-500 transition-colors';

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-gray-100">
      <Link
        to={`/projects/${code}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200"
      >
        &larr; Back to {code}
      </Link>

      <div className="mx-auto max-w-4xl">
        <h1 className="mb-6 text-2xl font-bold text-gray-100">New Issue</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Title */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brief summary of the issue"
              className={inputClass}
              autoFocus
            />
            {errors.title && (
              <p className="mt-1 text-xs text-red-400">{errors.title}</p>
            )}
          </div>

          {/* Type + Priority row */}
          <div className="grid grid-cols-2 gap-6">
            {/* Type */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">
                Type <span className="text-red-400">*</span>
              </label>
              <div className="flex gap-2">
                {issueTypes.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setType(t.value)}
                    className={`flex-1 rounded border px-3 py-2 text-sm font-medium transition ${
                      type === t.value
                        ? `${typeColors[t.value]} ring-2 ring-offset-2 ring-offset-gray-950 ring-white`
                        : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    <span className="block">{t.label}</span>
                    <span className="block text-[10px] opacity-60 mt-0.5">{t.desc}</span>
                  </button>
                ))}
              </div>
              {errors.type && (
                <p className="mt-1 text-xs text-red-400">{errors.type}</p>
              )}
            </div>

            {/* Priority */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">
                Priority <span className="text-red-400">*</span>
              </label>
              <div className="flex gap-2">
                {priorities.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`rounded px-3 py-2 text-xs font-bold transition ${priorityColors[p]} ${
                      priority === p
                        ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-950'
                        : 'opacity-50 hover:opacity-100'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
              {errors.priority && (
                <p className="mt-1 text-xs text-red-400">{errors.priority}</p>
              )}
            </div>
          </div>

          {/* Description */}
          <MarkdownEditor
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="Describe the issue in detail (markdown supported)"
            rows={10}
          />

          {/* Repro Steps (bug only) */}
          {type === 'bug' && (
            <MarkdownEditor
              label="Repro Steps"
              required
              value={reproSteps}
              onChange={setReproSteps}
              placeholder="1. Go to...\n2. Click on...\n3. Observe..."
              rows={8}
              error={errors.reproSteps}
            />
          )}

          {/* Screenshots */}
          <ScreenshotUploader
            attachments={attachments}
            onChange={setAttachments}
          />

          {/* Metadata row */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">Source</label>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Where did this come from?"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">Created By</label>
              <input
                type="text"
                value={createdBy}
                onChange={(e) => setCreatedBy(e.target.value)}
                placeholder="Your name"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 border-t border-gray-800 pt-6">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {mutation.isPending ? 'Creating...' : 'Create Issue'}
            </button>
            <button
              type="button"
              onClick={() => navigate(`/projects/${code}`)}
              className="rounded bg-gray-700 px-6 py-2.5 text-sm font-medium text-gray-300 hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
            {mutation.isError && (
              <p className="text-sm text-red-400">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Failed to create issue'}
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default IssueFormPage;
