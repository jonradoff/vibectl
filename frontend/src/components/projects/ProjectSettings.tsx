import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { updateProject, deleteProject } from '../../api/client';
import type { Project, CustomLink, HealthCheckConfig, DeploymentConfig, WebhookConfig } from '../../types';

const WEBHOOK_EVENTS = [
  { value: 'p0_issue_created', label: 'P0 Issue Created' },
  { value: 'health_check_down', label: 'Health Check Down' },
  { value: 'health_check_up', label: 'Health Check Up' },
  { value: 'feedback_triaged', label: 'Feedback Triaged' },
];

interface ProjectSettingsProps {
  project: Project;
}

function ProjectSettings({ project }: ProjectSettingsProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Form state
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [localPath, setLocalPath] = useState(project.links.localPath || '');
  const [githubUrl, setGithubUrl] = useState(project.links.githubUrl || '');
  const [customLinks, setCustomLinks] = useState<CustomLink[]>(
    project.links.custom || []
  );
  const [goals, setGoals] = useState<string[]>(project.goals || []);
  const [healthCheck, setHealthCheck] = useState<HealthCheckConfig>(
    project.healthCheck || {
      frontend: {},
      backend: {},
      monitorEnv: '',
    }
  );
  const [deployment, setDeployment] = useState<DeploymentConfig>(
    project.deployment || {}
  );
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>(project.webhooks || []);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([]);
  const [newWebhookSecret, setNewWebhookSecret] = useState('');

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Danger zone state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Reset form when project changes
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setLocalPath(project.links.localPath || '');
    setGithubUrl(project.links.githubUrl || '');
    setCustomLinks(project.links.custom || []);
    setGoals(project.goals || []);
    setHealthCheck(
      project.healthCheck || { frontend: {}, backend: {}, monitorEnv: '' }
    );
    setDeployment(project.deployment || {});
    setWebhooks(project.webhooks || []);
  }, [project]);

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const updateMutation = useMutation({
    mutationFn: () =>
      updateProject(project.id, {
        name,
        description,
        links: {
          localPath: localPath || undefined,
          githubUrl: githubUrl || undefined,
          custom: customLinks.length > 0 ? customLinks : undefined,
        },
        goals,
        healthCheck,
        deployment,
        webhooks: webhooks.length > 0 ? webhooks : [],
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', project.code] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setToast({ message: 'Project updated successfully', type: 'success' });
    },
    onError: (err: Error) => {
      setToast({ message: err.message, type: 'error' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.code] });
      navigate('/');
    },
    onError: (err: Error) => {
      setToast({ message: err.message, type: 'error' });
    },
  });

  // Custom links handlers
  const addCustomLink = () => {
    setCustomLinks([...customLinks, { label: '', url: '' }]);
  };

  const removeCustomLink = (index: number) => {
    setCustomLinks(customLinks.filter((_, i) => i !== index));
  };

  const updateCustomLink = (index: number, field: keyof CustomLink, value: string) => {
    const updated = [...customLinks];
    updated[index] = { ...updated[index], [field]: value };
    setCustomLinks(updated);
  };

  // Goals handlers
  const addGoal = () => {
    setGoals([...goals, '']);
  };

  const removeGoal = (index: number) => {
    setGoals(goals.filter((_, i) => i !== index));
  };

  const updateGoal = (index: number, value: string) => {
    const updated = [...goals];
    updated[index] = value;
    setGoals(updated);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate();
  };

  const handleDelete = () => {
    deleteMutation.mutate();
  };

  return (
    <div className="space-y-6">
      {/* Edit Project Details */}
      <form onSubmit={handleSave} className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h3 className="text-lg font-semibold text-gray-100 mb-4">Edit Project Details</h3>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-indigo-500"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-indigo-500 resize-y"
            />
          </div>

          {/* Local Path */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Local Path</label>
            <input
              type="text"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="/path/to/project"
              className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* GitHub URL */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">GitHub URL</label>
            <input
              type="text"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Custom Links */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Custom Links</label>
            <div className="space-y-2">
              {customLinks.map((link, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={link.label}
                    onChange={(e) => updateCustomLink(index, 'label', e.target.value)}
                    placeholder="Label"
                    className="flex-1 bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    type="text"
                    value={link.url}
                    onChange={(e) => updateCustomLink(index, 'url', e.target.value)}
                    placeholder="https://..."
                    className="flex-1 bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => removeCustomLink(index)}
                    className="text-red-400 hover:text-red-300 px-2 py-2"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addCustomLink}
              className="mt-2 text-sm text-indigo-400 hover:text-indigo-300"
            >
              + Add Link
            </button>
          </div>

          {/* Goals */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Goals</label>
            <div className="space-y-2">
              {goals.map((goal, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={goal}
                    onChange={(e) => updateGoal(index, e.target.value)}
                    placeholder="Project goal..."
                    className="flex-1 bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => removeGoal(index)}
                    className="text-red-400 hover:text-red-300 px-2 py-2"
                  >
                    &times;
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

          {/* Health Check Configuration */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-3">Health Checks</label>

            {/* Monitoring mode */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-400 mb-1">Monitor Environment</label>
              <div className="flex gap-3">
                {[
                  { value: '', label: 'Off' },
                  { value: 'dev', label: 'Dev' },
                  { value: 'prod', label: 'Production' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      setHealthCheck({ ...healthCheck, monitorEnv: opt.value })
                    }
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                      healthCheck.monitorEnv === opt.value
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Frontend URLs */}
            <div className="mb-3 rounded bg-gray-700/50 p-3">
              <p className="text-xs font-medium text-gray-400 mb-2">Frontend</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Dev URL</label>
                  <input
                    type="text"
                    value={healthCheck.frontend.devUrl || ''}
                    onChange={(e) =>
                      setHealthCheck({
                        ...healthCheck,
                        frontend: { ...healthCheck.frontend, devUrl: e.target.value },
                      })
                    }
                    placeholder="http://localhost:3000"
                    className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Prod URL</label>
                  <input
                    type="text"
                    value={healthCheck.frontend.prodUrl || ''}
                    onChange={(e) =>
                      setHealthCheck({
                        ...healthCheck,
                        frontend: { ...healthCheck.frontend, prodUrl: e.target.value },
                      })
                    }
                    placeholder="https://app.example.com"
                    className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>

            {/* Backend URLs */}
            <div className="rounded bg-gray-700/50 p-3">
              <p className="text-xs font-medium text-gray-400 mb-2">Backend</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Dev URL</label>
                  <input
                    type="text"
                    value={healthCheck.backend.devUrl || ''}
                    onChange={(e) =>
                      setHealthCheck({
                        ...healthCheck,
                        backend: { ...healthCheck.backend, devUrl: e.target.value },
                      })
                    }
                    placeholder="http://localhost:4380/health"
                    className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Prod URL</label>
                  <input
                    type="text"
                    value={healthCheck.backend.prodUrl || ''}
                    onChange={(e) =>
                      setHealthCheck({
                        ...healthCheck,
                        backend: { ...healthCheck.backend, prodUrl: e.target.value },
                      })
                    }
                    placeholder="https://api.example.com/health"
                    className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Deployment */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-3">Deployment</label>

            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-400 mb-1">Provider</label>
              <select
                value={deployment.provider || ''}
                onChange={(e) => setDeployment({ ...deployment, provider: e.target.value })}
                className="w-full max-w-xs bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              >
                <option value="">None</option>
                <option value="flyio">Fly.io</option>
                <option value="aws">AWS</option>
                <option value="vercel">Vercel</option>
                <option value="manual">Manual</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="space-y-3 rounded bg-gray-700/50 p-3 mb-3">
              <p className="text-xs font-medium text-gray-400 mb-1">Commands</p>
              {[
                { key: 'startDev' as const, label: 'Start Dev', placeholder: 'npm run dev' },
                { key: 'stopDev' as const, label: 'Stop Dev', placeholder: 'kill process or docker-compose down' },
                { key: 'deployProd' as const, label: 'Deploy Production', placeholder: 'fly deploy or git push' },
                { key: 'restartProd' as const, label: 'Restart Production', placeholder: 'fly apps restart myapp' },
                { key: 'viewLogs' as const, label: 'View Logs', placeholder: 'fly logs or docker logs' },
              ].map((cmd) => (
                <div key={cmd.key}>
                  <label className="block text-xs text-gray-500 mb-1">{cmd.label}</label>
                  <input
                    type="text"
                    value={deployment[cmd.key] || ''}
                    onChange={(e) => setDeployment({ ...deployment, [cmd.key]: e.target.value })}
                    placeholder={cmd.placeholder}
                    className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}
            </div>

            {deployment.provider === 'flyio' && (
              <div className="rounded bg-gray-700/50 p-3 mb-3">
                <p className="text-xs font-medium text-gray-400 mb-2">Fly.io</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">App Name</label>
                    <input
                      type="text"
                      value={deployment.flyApp || ''}
                      onChange={(e) => setDeployment({ ...deployment, flyApp: e.target.value })}
                      placeholder="my-app"
                      className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Region</label>
                    <input
                      type="text"
                      value={deployment.flyRegion || ''}
                      onChange={(e) => setDeployment({ ...deployment, flyRegion: e.target.value })}
                      placeholder="auto"
                      className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-500 mb-1">Deployment Notes</label>
              <textarea
                value={deployment.notes || ''}
                onChange={(e) => setDeployment({ ...deployment, notes: e.target.value })}
                rows={3}
                placeholder="Any additional deployment notes (markdown supported)..."
                className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 resize-y"
              />
            </div>
          </div>

          {/* Error message */}
          {updateMutation.isError && (
            <p className="text-sm text-red-400">{updateMutation.error.message}</p>
          )}

          {/* Save button */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={updateMutation.isPending}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded px-4 py-2 transition-colors"
            >
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </form>

      {/* Webhooks */}
      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h3 className="text-lg font-semibold text-gray-100 mb-4">Webhooks</h3>
        <p className="text-sm text-gray-400 mb-4">
          Receive HTTP POST notifications when project events occur. Changes are saved with the project settings above.
        </p>

        {/* Existing webhooks */}
        {webhooks.length > 0 && (
          <div className="space-y-2 mb-4">
            {webhooks.map((wh, idx) => (
              <div key={idx} className="rounded border border-gray-700 bg-gray-900/50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono text-gray-200 truncate">{wh.url}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {wh.events.map((e) => (
                        <span key={e} className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-xs text-indigo-300">
                          {e}
                        </span>
                      ))}
                    </div>
                    {wh.secret && (
                      <p className="mt-1 text-xs text-gray-600">HMAC secret configured</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setWebhooks(webhooks.filter((_, i) => i !== idx))}
                    className="shrink-0 text-red-400 hover:text-red-300 text-sm px-2 py-1"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add new webhook */}
        <div className="rounded border border-gray-700 bg-gray-900/30 p-4 space-y-3">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Add Webhook</p>
          <div>
            <label className="block text-xs text-gray-500 mb-1">URL</label>
            <input
              type="url"
              value={newWebhookUrl}
              onChange={(e) => setNewWebhookUrl(e.target.value)}
              placeholder="https://hooks.example.com/vibectl"
              className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-2">Events</label>
            <div className="flex flex-wrap gap-2">
              {WEBHOOK_EVENTS.map((ev) => (
                <label key={ev.value} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newWebhookEvents.includes(ev.value)}
                    onChange={(e) => {
                      if (e.target.checked) setNewWebhookEvents([...newWebhookEvents, ev.value]);
                      else setNewWebhookEvents(newWebhookEvents.filter((v) => v !== ev.value));
                    }}
                    className="rounded border-gray-600 bg-gray-700 text-indigo-600"
                  />
                  <span className="text-xs text-gray-300">{ev.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Secret (optional, for HMAC-SHA256 signature)</label>
            <input
              type="text"
              value={newWebhookSecret}
              onChange={(e) => setNewWebhookSecret(e.target.value)}
              placeholder="my-secret-key"
              className="w-full bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              if (!newWebhookUrl || newWebhookEvents.length === 0) return;
              setWebhooks([...webhooks, {
                url: newWebhookUrl,
                events: newWebhookEvents,
                secret: newWebhookSecret || undefined,
              }]);
              setNewWebhookUrl('');
              setNewWebhookEvents([]);
              setNewWebhookSecret('');
            }}
            disabled={!newWebhookUrl || newWebhookEvents.length === 0}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            Add Webhook
          </button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-gray-800 rounded-lg p-6 border border-red-900/50">
        <h3 className="text-lg font-semibold text-red-400 mb-4">Danger Zone</h3>

        {!showDeleteConfirm ? (
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className="bg-red-600 hover:bg-red-500 text-white font-medium rounded px-4 py-2 transition-colors"
          >
            Delete Project
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-300">
              Type the project code <span className="font-mono font-bold text-red-400">{project.code}</span> to confirm deletion:
            </p>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={project.code}
              className="w-full max-w-xs bg-gray-700 border border-gray-600 text-gray-100 rounded px-3 py-2 focus:outline-none focus:border-red-500"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteConfirmText !== project.code || deleteMutation.isPending}
                className="bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded px-4 py-2 transition-colors"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Confirm Delete'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText('');
                }}
                className="text-gray-400 hover:text-gray-300 px-4 py-2"
              >
                Cancel
              </button>
            </div>
            {deleteMutation.isError && (
              <p className="text-sm text-red-400">{deleteMutation.error.message}</p>
            )}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg text-sm font-medium z-50 ${
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default ProjectSettings;
