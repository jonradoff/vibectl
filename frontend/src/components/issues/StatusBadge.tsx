const statusColorMap: Record<string, string> = {
  open: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  fixed: 'bg-green-500/20 text-green-400 border-green-500/30',
  closed: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  approved: 'bg-teal-500/20 text-teal-400 border-teal-500/30',
  implemented: 'bg-green-500/20 text-green-400 border-green-500/30',
  cannot_reproduce: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  backlogged: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
};

interface StatusBadgeProps {
  status: string;
}

function StatusBadge({ status }: StatusBadgeProps) {
  const colors = statusColorMap[status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}
    >
      {label}
    </span>
  );
}

export default StatusBadge;
