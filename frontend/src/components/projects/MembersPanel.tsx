import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listProjectMembers, upsertProjectMember, removeProjectMember, listUsersDirectory } from '../../api/client';
import type { ProjectMember, User, ProjectRole } from '../../types';

const PROJECT_ROLES: ProjectRole[] = ['owner', 'devops', 'developer', 'contributor', 'reporter', 'viewer'];

const roleBadgeClass = (role: ProjectRole): string => {
  const map: Record<ProjectRole, string> = {
    owner: 'bg-purple-500/20 text-purple-300',
    devops: 'bg-orange-500/20 text-orange-300',
    developer: 'bg-blue-500/20 text-blue-300',
    contributor: 'bg-green-500/20 text-green-300',
    reporter: 'bg-yellow-500/20 text-yellow-300',
    viewer: 'bg-gray-500/20 text-gray-300',
  };
  return map[role];
};

export default function MembersPanel({ projectId }: { projectCode: string }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState('');

  const { data: members = [], isLoading } = useQuery<ProjectMember[]>({
    queryKey: ['projectMembers', projectId],
    queryFn: () => listProjectMembers(projectId),
  });

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ['usersDirectory'],
    queryFn: () => listUsersDirectory(),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['projectMembers', projectId] });

  const handleUpsert = async (userId: string, role: ProjectRole) => {
    setError('');
    try {
      await upsertProjectMember(projectCode, userId, role);
      await invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleRemove = async (userId: string) => {
    setError('');
    try {
      await removeProjectMember(projectCode, userId);
      await invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  // Users not yet on this project
  const memberUserIds = new Set(members.map(m => m.userId));
  const availableUsers = allUsers.filter(u => !memberUserIds.has(u.id));

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(2)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-gray-800" />)}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {members.length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm border border-gray-800 rounded-xl">
          No members yet. Add team members below.
        </div>
      ) : (
        <div className="space-y-2">
          {members.map(m => (
            <MemberRow
              key={m.id}
              member={m}
              onChangeRole={(role) => handleUpsert(m.userId, role)}
              onRemove={() => handleRemove(m.userId)}
            />
          ))}
        </div>
      )}

      {showAdd ? (
        <AddMemberForm
          users={availableUsers}
          onAdd={handleUpsert}
          onClose={() => setShowAdd(false)}
        />
      ) : (
        availableUsers.length > 0 && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add member
          </button>
        )
      )}
    </div>
  );
}

function MemberRow({ member, onChangeRole, onRemove }: {
  member: ProjectMember;
  onChangeRole: (role: ProjectRole) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const displayName = member.user?.displayName || member.userId;
  const email = member.user?.email;
  const ghUsername = member.user?.githubUsername;

  return (
    <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5">
      <div className="w-8 h-8 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-300 font-semibold text-sm shrink-0">
        {displayName.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white font-medium truncate">{displayName}</p>
        <p className="text-xs text-gray-500 truncate">
          {email || (ghUsername ? `@${ghUsername}` : '')}
        </p>
      </div>
      <select
        value={member.role}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          await onChangeRole(e.target.value as ProjectRole);
          setBusy(false);
        }}
        className="bg-gray-800 border border-gray-700 text-xs text-gray-300 rounded px-2 py-1 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
      >
        {PROJECT_ROLES.map(r => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <span className={`hidden sm:inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${roleBadgeClass(member.role)}`}>
        {member.role}
      </span>
      <button
        disabled={busy}
        onClick={async () => { setBusy(true); await onRemove(); setBusy(false); }}
        className="text-gray-600 hover:text-red-400 transition-colors disabled:opacity-50 p-1 rounded"
        title="Remove"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function AddMemberForm({ users, onAdd, onClose }: {
  users: User[];
  onAdd: (userId: string, role: ProjectRole) => Promise<void>;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState(users[0]?.id || '');
  const [role, setRole] = useState<ProjectRole>('developer');
  const [busy, setBusy] = useState(false);

  if (users.length === 0) return null;

  const handleAdd = async () => {
    if (!userId) return;
    setBusy(true);
    await onAdd(userId, role);
    onClose();
  };

  return (
    <div className="flex items-center gap-2 flex-wrap p-3 bg-gray-800/50 border border-gray-700 rounded-xl">
      <select
        value={userId}
        onChange={e => setUserId(e.target.value)}
        className="bg-gray-800 border border-gray-700 text-sm text-white rounded px-2 py-1.5 focus:outline-none focus:border-indigo-500"
      >
        {users.map(u => (
          <option key={u.id} value={u.id}>{u.displayName}</option>
        ))}
      </select>
      <select
        value={role}
        onChange={e => setRole(e.target.value as ProjectRole)}
        className="bg-gray-800 border border-gray-700 text-sm text-gray-300 rounded px-2 py-1.5 focus:outline-none focus:border-indigo-500"
      >
        {PROJECT_ROLES.map(r => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <button
        disabled={busy || !userId}
        onClick={handleAdd}
        className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 rounded transition-colors"
      >
        {busy ? 'Adding…' : 'Add'}
      </button>
      <button
        onClick={onClose}
        className="text-gray-500 hover:text-gray-300 text-sm px-2 py-1.5 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}
