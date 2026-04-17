import { NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ModeIndicator } from './ModeIndicator';

function TopNav() {
  const { logout, currentUser } = useAuth();
  const isSuperAdmin = currentUser?.globalRole === 'super_admin';

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
      isActive
        ? 'bg-gray-800 text-white'
        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
    }`;

  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-gray-900 border-b border-gray-800 z-30 flex items-center gap-2 px-4">
      {/* Logo */}
      <NavLink to="/" className="flex items-center gap-2 mr-2 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">
          V
        </div>
        <span className="text-base font-semibold text-white tracking-tight">VibeCtl</span>
      </NavLink>

      <ModeIndicator />

      {/* Divider */}
      <div className="w-px h-6 bg-gray-700 mx-1 shrink-0" />

      {/* Nav links */}
      <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-none flex-1 min-w-0">
        <NavLink to="/" end className={linkClass}>Dashboard</NavLink>
        <NavLink to="/feedback" className={linkClass}>Feedback</NavLink>
        <NavLink to="/review" className={linkClass}>PM Review</NavLink>
        <NavLink to="/prompts" className={linkClass}>Prompts</NavLink>
        <NavLink to="/activity-log" className={linkClass}>Activity</NavLink>
        {isSuperAdmin && (
          <NavLink to="/settings" className={linkClass}>Settings</NavLink>
        )}
        {isSuperAdmin && (
          <NavLink to="/users" className={linkClass}>Users</NavLink>
        )}
      </nav>

      {/* Right: user + logout */}
      {currentUser && (
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <NavLink
            to="/profile"
            className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-800/50 transition-colors group"
          >
            <div className="w-6 h-6 rounded-full bg-indigo-600/40 flex items-center justify-center text-indigo-300 font-semibold text-xs shrink-0">
              {currentUser.displayName.charAt(0).toUpperCase()}
            </div>
            <span className="text-sm text-gray-400 group-hover:text-gray-200 transition-colors hidden sm:block">
              {currentUser.displayName}
            </span>
          </NavLink>
          <button
            onClick={() => logout()}
            title="Sign out"
            className="p-1.5 rounded-md text-gray-600 hover:text-gray-300 hover:bg-gray-800/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}

export default TopNav;
