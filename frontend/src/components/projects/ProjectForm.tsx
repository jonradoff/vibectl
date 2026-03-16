import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createProject, checkDir, ensureDir } from '../../api/client';
import type { ProjectLinks } from '../../types';

interface ProjectFormProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function ProjectForm({ open, onClose, onCreated }: ProjectFormProps) {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [goals, setGoals] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [pendingDirCreate, setPendingDirCreate] = useState<string | null>(null);
  const [creatingDir, setCreatingDir] = useState(false);

  const mutation = useMutation({
    mutationFn: (data: {
      name: string;
      code: string;
      description: string;
      links: ProjectLinks;
      goals: string[];
    }) => createProject(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['globalDashboard'] });
      resetForm();
      onCreated();
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  function resetForm() {
    setName('');
    setCode('');
    setDescription('');
    setLocalPath('');
    setGithubUrl('');
    setGoals([]);
    setError('');
    setPendingDirCreate(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Name is required.');
      return;
    }

    if (!/^[A-Z]{3,5}$/.test(code)) {
      setError('Code must be 3-5 uppercase letters.');
      return;
    }

    // Check if local path directory exists
    if (localPath.trim()) {
      try {
        const result = await checkDir(localPath.trim());
        if (!result.exists) {
          setPendingDirCreate(localPath.trim());
          return;
        }
      } catch {
        // If check fails, proceed anyway — backend will handle it
      }
    }

    doCreate();
  }

  function doCreate() {
    const links: ProjectLinks = {};
    if (localPath.trim()) links.localPath = localPath.trim();
    if (githubUrl.trim()) links.githubUrl = githubUrl.trim();

    const filteredGoals = goals.filter((g) => g.trim() !== '');

    mutation.mutate({
      name: name.trim(),
      code,
      description: description.trim(),
      links,
      goals: filteredGoals,
    });
  }

  async function handleCreateDirAndSubmit() {
    if (!pendingDirCreate) return;
    setCreatingDir(true);
    try {
      await ensureDir(pendingDirCreate);
      setPendingDirCreate(null);
      doCreate();
    } catch (err) {
      setError(`Failed to create directory: ${err}`);
      setPendingDirCreate(null);
    } finally {
      setCreatingDir(false);
    }
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  function addGoal() {
    setGoals([...goals, '']);
  }

  function removeGoal(index: number) {
    setGoals(goals.filter((_, i) => i !== index));
  }

  function updateGoal(index: number, value: string) {
    const updated = [...goals];
    updated[index] = value;
    setGoals(updated);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg bg-gray-800 p-6">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">New Project</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-white"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm text-gray-300">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 focus:border-indigo-500 focus:outline-none"
              placeholder="My Project"
            />
          </div>

          {/* Code */}
          <div>
            <label className="mb-1 block text-sm text-gray-300">
              Code * <span className="text-gray-500">(3-5 uppercase letters)</span>
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 font-mono text-gray-100 focus:border-indigo-500 focus:outline-none"
              placeholder="PROJ"
              maxLength={5}
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-sm text-gray-300">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 focus:border-indigo-500 focus:outline-none"
              placeholder="Project description (markdown supported)"
            />
          </div>

          {/* Local Path */}
          <div>
            <label className="mb-1 block text-sm text-gray-300">Local Path</label>
            <input
              type="text"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 focus:border-indigo-500 focus:outline-none"
              placeholder="/Users/you/projects/myproject"
            />
          </div>

          {/* GitHub URL */}
          <div>
            <label className="mb-1 block text-sm text-gray-300">GitHub URL</label>
            <input
              type="text"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 focus:border-indigo-500 focus:outline-none"
              placeholder="https://github.com/user/repo"
            />
          </div>

          {/* Goals */}
          <div>
            <label className="mb-1 block text-sm text-gray-300">Goals</label>
            <div className="space-y-2">
              {goals.map((goal, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="text"
                    value={goal}
                    onChange={(e) => updateGoal(index, e.target.value)}
                    className="flex-1 rounded border border-gray-600 bg-gray-700 px-3 py-2 text-gray-100 focus:border-indigo-500 focus:outline-none"
                    placeholder={`Goal ${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeGoal(index)}
                    className="rounded border border-gray-600 px-3 py-2 text-sm text-gray-400 hover:border-red-500 hover:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addGoal}
              className="mt-2 text-sm text-indigo-400 hover:text-indigo-300"
            >
              + Add Goal
            </button>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          {/* Footer */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded bg-gray-600 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-gray-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {mutation.isPending ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>

        {/* Directory creation prompt */}
        {pendingDirCreate && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
            <div className="rounded-lg border border-gray-700 bg-gray-800 p-5 max-w-md text-center space-y-3">
              <p className="text-sm text-gray-300">
                Directory does not exist:
              </p>
              <p className="text-sm font-mono text-yellow-400 break-all">{pendingDirCreate}</p>
              <p className="text-sm text-gray-400">Would you like to create it?</p>
              <div className="flex justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setPendingDirCreate(null)}
                  className="rounded bg-gray-600 px-4 py-1.5 text-sm text-gray-200 hover:bg-gray-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreateDirAndSubmit}
                  disabled={creatingDir}
                  className="rounded bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {creatingDir ? 'Creating...' : 'Create & Continue'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProjectForm;
