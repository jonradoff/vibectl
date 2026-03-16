import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import {
  getIssue,
  updateIssue,
  transitionIssueStatus,
  deleteIssue,
  listComments,
  createComment,
  deleteComment,
} from '../api/client';
import type { Issue, Priority, IssueComment } from '../types';
import { priorityColors, typeColors, statusTransitions } from '../types';
import StatusBadge from '../components/issues/StatusBadge';

function IssuePage() {
  const { code, issueKey } = useParams<{ code: string; issueKey: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState<Priority>('P3');
  const [editDueDate, setEditDueDate] = useState('');
  const [editReproSteps, setEditReproSteps] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('admin');

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const {
    data: issue,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['issue', issueKey],
    queryFn: () => getIssue(issueKey!),
    enabled: !!issueKey,
  });

  const transitionMutation = useMutation({
    mutationFn: (status: string) => transitionIssueStatus(issueKey!, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueKey] });
      showToast('Status updated successfully');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Issue>) => updateIssue(issueKey!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueKey] });
      setEditing(false);
      showToast('Issue updated successfully');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteIssue(issueKey!),
    onSuccess: () => {
      navigate(`/projects/${code}`);
    },
  });

  const { data: comments } = useQuery({
    queryKey: ['comments', issueKey],
    queryFn: () => listComments(issueKey!),
    enabled: !!issueKey,
  });

  const addCommentMutation = useMutation({
    mutationFn: (data: { body: string; author: string }) => createComment(issueKey!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', issueKey] });
      setCommentBody('');
      showToast('Comment added');
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: (commentId: string) => deleteComment(issueKey!, commentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', issueKey] });
    },
  });

  const startEditing = () => {
    if (!issue) return;
    setEditTitle(issue.title);
    setEditDescription(issue.description);
    setEditPriority(issue.priority);
    setEditDueDate(issue.dueDate ? issue.dueDate.split('T')[0] : '');
    setEditReproSteps(issue.reproSteps ?? '');
    setEditing(true);
  };

  const saveEdit = () => {
    const data: Partial<Issue> = {
      title: editTitle,
      description: editDescription,
      priority: editPriority,
      dueDate: editDueDate || undefined,
      reproSteps: issue?.type === 'bug' ? editReproSteps : undefined,
    };
    updateMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <p className="text-gray-400">Loading issue...</p>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <p className="text-red-400">
          {error instanceof Error ? error.message : 'Issue not found'}
        </p>
      </div>
    );
  }

  const validTransitions =
    statusTransitions[issue.type]?.[issue.status] ?? [];

  const priorities: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-gray-100">
      {/* Toast */}
      {toast && (
        <div className="fixed right-6 top-6 z-50 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}

      {/* Back link */}
      <Link
        to={`/projects/${code}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200"
      >
        &larr; Back to {code}
      </Link>

      {/* Header */}
      <div className="mb-6 rounded-lg bg-gray-800 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="mb-2 flex items-center gap-3">
              <span className="rounded bg-gray-700 px-2 py-0.5 text-xs font-mono text-gray-300">
                {issue.issueKey}
              </span>
            </div>
            {editing ? (
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full rounded bg-gray-700 px-3 py-2 text-xl font-bold text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <h1 className="text-xl font-bold text-gray-100">{issue.title}</h1>
            )}
          </div>
          <div className="flex gap-2">
            {editing ? (
              <>
                <button
                  onClick={saveEdit}
                  disabled={updateMutation.isPending}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-600"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={startEditing}
                  className="rounded bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-600"
                >
                  Edit
                </button>
                {confirmDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-red-400">Delete?</span>
                    <button
                      onClick={() => deleteMutation.mutate()}
                      disabled={deleteMutation.isPending}
                      className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="rounded bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-600"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-600"
                  >
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Metadata bar */}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span
            className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${typeColors[issue.type]}`}
          >
            {issue.type.charAt(0).toUpperCase() + issue.type.slice(1)}
          </span>
          <span
            className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${priorityColors[issue.priority]}`}
          >
            {issue.priority}
          </span>
          <StatusBadge status={issue.status} />
          <span className="text-gray-500">|</span>
          <span className="text-gray-400">
            Created by <span className="text-gray-200">{issue.createdBy}</span>
          </span>
          <span className="text-gray-400">
            on{' '}
            {new Date(issue.createdAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </span>
          {issue.dueDate && (
            <span className="text-gray-400">
              Due{' '}
              {new Date(issue.dueDate).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          )}
        </div>
      </div>

      {/* Priority editor in edit mode */}
      {editing && (
        <div className="mb-6 rounded-lg bg-gray-800 p-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Priority
          </h2>
          <div className="flex gap-2">
            {priorities.map((p) => (
              <button
                key={p}
                onClick={() => setEditPriority(p)}
                className={`rounded px-3 py-1.5 text-xs font-bold ${priorityColors[p]} ${
                  editPriority === p
                    ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-800'
                    : 'opacity-60 hover:opacity-100'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {(issue.dueDate || editDueDate) && (
            <div className="mt-4">
              <h2 className="mb-2 text-sm font-semibold text-gray-300 uppercase tracking-wide">
                Due Date
              </h2>
              <input
                type="date"
                value={editDueDate}
                onChange={(e) => setEditDueDate(e.target.value)}
                className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
        </div>
      )}

      {/* Description */}
      <div className="mb-6 rounded-lg bg-gray-800 p-6">
        <h2 className="mb-3 text-sm font-semibold text-gray-300 uppercase tracking-wide">
          Description
        </h2>
        {editing ? (
          <textarea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            rows={8}
            className="w-full rounded bg-gray-700 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{issue.description}</ReactMarkdown>
          </div>
        )}
      </div>

      {/* Repro Steps (bugs only) */}
      {issue.type === 'bug' && (
        <div className="mb-6 rounded-lg bg-gray-800 p-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Repro Steps
          </h2>
          {editing ? (
            <textarea
              value={editReproSteps}
              onChange={(e) => setEditReproSteps(e.target.value)}
              rows={6}
              className="w-full rounded bg-gray-700 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
            />
          ) : issue.reproSteps ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown>{issue.reproSteps}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm italic text-gray-500">No repro steps provided.</p>
          )}
        </div>
      )}

      {/* Attachments */}
      {issue.attachments && issue.attachments.length > 0 && (
        <div className="mb-6 rounded-lg bg-gray-800 p-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Screenshots ({issue.attachments.length})
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {issue.attachments.map((att) => (
              <a
                key={att.id}
                href={att.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group block overflow-hidden rounded-lg border border-gray-700 hover:border-indigo-500 transition-colors"
              >
                <img
                  src={att.url}
                  alt={att.filename}
                  className="w-full h-32 object-cover"
                />
                <div className="px-2 py-1.5 bg-gray-900/80">
                  <p className="text-xs text-gray-400 truncate group-hover:text-indigo-400">{att.filename}</p>
                  <p className="text-[10px] text-gray-600">{(att.size / 1024).toFixed(0)} KB</p>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Source */}
      {issue.source && (
        <div className="mb-6 rounded-lg bg-gray-800 p-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Source
          </h2>
          <p className="text-sm text-gray-300">{issue.source}</p>
        </div>
      )}

      {/* Status Transitions */}
      {validTransitions.length > 0 && !editing && (
        <div className="mb-6 rounded-lg bg-gray-800 p-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Transition Status
          </h2>
          <div className="flex flex-wrap gap-2">
            {validTransitions.map((nextStatus) => (
              <button
                key={nextStatus}
                onClick={() => transitionMutation.mutate(nextStatus)}
                disabled={transitionMutation.isPending}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {transitionMutation.isPending ? '...' : nextStatus.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Comments */}
      <div className="mb-6 rounded-lg bg-gray-800 p-6">
        <h2 className="mb-4 text-sm font-semibold text-gray-300 uppercase tracking-wide">
          Comments ({comments?.length ?? 0})
        </h2>

        {/* Comment list */}
        {comments && comments.length > 0 && (
          <div className="mb-4 space-y-3">
            {comments.map((comment: IssueComment) => (
              <div key={comment.id} className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{comment.author}</span>
                    <span className="text-xs text-gray-500">
                      {new Date(comment.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <button
                    onClick={() => deleteCommentMutation.mutate(comment.id)}
                    disabled={deleteCommentMutation.isPending}
                    className="rounded px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-700 hover:text-red-400 transition-colors"
                    title="Delete comment"
                  >
                    Delete
                  </button>
                </div>
                <p className="text-sm text-gray-300 whitespace-pre-wrap">{comment.body}</p>
              </div>
            ))}
          </div>
        )}

        {/* Add comment form */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={commentAuthor}
              onChange={(e) => setCommentAuthor(e.target.value)}
              placeholder="Author"
              className="w-32 rounded bg-gray-700 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
            className="w-full rounded bg-gray-700 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={() => {
              if (commentBody.trim()) {
                addCommentMutation.mutate({ body: commentBody, author: commentAuthor || 'admin' });
              }
            }}
            disabled={addCommentMutation.isPending || !commentBody.trim()}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {addCommentMutation.isPending ? 'Adding...' : 'Add Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default IssuePage;
