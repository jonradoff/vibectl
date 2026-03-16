import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSettings } from '../api/client';
import type { AppSettings } from '../types';

function SettingsPage() {
  const queryClient = useQueryClient();
  const [autoRegen, setAutoRegen] = useState(false);
  const [schedule, setSchedule] = useState('daily');
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  useEffect(() => {
    if (settings) {
      setAutoRegen(settings.vibectlMdAutoRegen);
      setSchedule(settings.vibectlMdSchedule || 'daily');
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: Partial<AppSettings>) => updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast('Settings saved');
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      vibectlMdAutoRegen: autoRegen,
      vibectlMdSchedule: autoRegen ? schedule : '',
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 p-6">
        <div className="h-48 animate-pulse rounded-lg bg-gray-800" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6 text-gray-100">
      {toast && (
        <div className="fixed right-6 top-6 z-50 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="max-w-2xl">
        <h1 className="mb-2 text-2xl font-bold text-white">Settings</h1>
        <p className="mb-6 text-gray-400 text-sm">Application-wide configuration for VibeCtl.</p>

        {/* VIBECTL.md Auto-Regen */}
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 mb-6">
          <h2 className="mb-4 text-base font-semibold text-white">VIBECTL.md Auto-Regeneration</h2>

          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => setAutoRegen(!autoRegen)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoRegen ? 'bg-indigo-600' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoRegen ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="text-sm text-gray-300">
              {autoRegen ? 'Enabled' : 'Disabled'} — automatically regenerate VIBECTL.md for all projects
            </span>
          </div>

          {autoRegen && (
            <div className="mt-4">
              <label className="mb-2 block text-sm font-medium text-gray-300">Schedule</label>
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="rounded border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-200 outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                VIBECTL.md will be regenerated for all non-archived projects on this schedule.
              </p>
            </div>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
        </button>

        {settings?.updatedAt && (
          <p className="mt-3 text-xs text-gray-600">
            Last updated: {new Date(settings.updatedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}

export default SettingsPage;
