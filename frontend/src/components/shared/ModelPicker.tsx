import { useEffect, useState } from 'react';
import { getAvailableModels } from '../../api/client';
import type { AnthropicModel } from '../../types';

interface Props {
  value: string;
  onChange: (model: string) => void;
  // When true, the picker offers an "Inherit" option that sets value="".
  // Used on per-project settings where empty means "fall back to server default".
  allowInherit?: boolean;
  inheritLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

// ModelPicker — lazy-loads the available Claude models when opened. Cached on
// the backend for 5 min; press Refresh to bypass.
export function ModelPicker({
  value,
  onChange,
  allowInherit = false,
  inheritLabel = 'Use server default',
  disabled = false,
  placeholder = 'Select a model',
  className = '',
}: Props) {
  const [models, setModels] = useState<AnthropicModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAvailableModels(refresh);
      setModels(res.models);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Load on mount so the native <select> has options ready the moment it opens.
  // Server caches for 5 min, so the extra calls cost nothing.
  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the current value even if it's not in the fetched list — supports
  // free-form entries the user typed before a list refresh.
  const optionIds = new Set((models ?? []).map((m) => m.id));
  const showStaleValue = value && !allowInherit && !optionIds.has(value);
  const showStaleValueForInherit = value && allowInherit && !optionIds.has(value);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || loading}
        className="flex-1 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 disabled:opacity-50"
      >
        {allowInherit && <option value="">{inheritLabel}</option>}
        {!allowInherit && !value && <option value="">{placeholder}</option>}
        {showStaleValue && <option value={value}>{value} (current)</option>}
        {showStaleValueForInherit && <option value={value}>{value} (current — not in list)</option>}
        {(models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName || m.id}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => load(true)}
        disabled={loading || disabled}
        title="Refresh model list from Anthropic"
        className="px-2 py-1 text-[10px] bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-gray-200 disabled:opacity-50"
      >
        {loading ? '…' : '↻'}
      </button>
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}
