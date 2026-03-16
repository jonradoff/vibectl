import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { searchIssues } from '../../api/client';
import type { Issue } from '../../types';

interface Breadcrumb {
  label: string;
  href?: string;
}

interface HeaderProps {
  title: string;
  breadcrumbs?: Breadcrumb[];
}

function Header({ title, breadcrumbs }: HeaderProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Issue[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await searchIssues(query.trim());
        setResults(res.slice(0, 8));
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const priorityColors: Record<string, string> = {
    P0: 'text-red-400', P1: 'text-orange-400', P2: 'text-yellow-400',
    P3: 'text-blue-400', P4: 'text-gray-400', P5: 'text-gray-500',
  };

  const handleSelect = (issue: Issue) => {
    // Extract code from issueKey e.g. "MYAPP-0042" -> "MYAPP"
    const code = issue.issueKey.split('-')[0];
    navigate(`/projects/${code}/issues/${issue.issueKey}`);
    setQuery('');
    setOpen(false);
  };

  return (
    <header className="h-16 border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm flex items-center justify-between px-6 sticky top-0 z-20">
      <div className="flex flex-col justify-center">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1.5 text-xs text-gray-500 mb-0.5">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span>/</span>}
                {crumb.href ? (
                  <Link to={crumb.href} className="hover:text-gray-300 transition-colors">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-gray-400">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-lg font-semibold text-white leading-tight">{title}</h1>
      </div>

      {/* Search */}
      <div className="relative" ref={ref}>
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search issues..."
          className="w-64 pl-9 pr-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
        )}

        {open && results.length > 0 && (
          <div className="absolute right-0 top-full mt-1.5 w-96 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-50">
            {results.map(issue => (
              <button
                key={issue.id}
                onClick={() => handleSelect(issue)}
                className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-800 transition-colors text-left border-b border-gray-800 last:border-0"
              >
                <span className={`text-xs font-bold mt-0.5 shrink-0 ${priorityColors[issue.priority] ?? 'text-gray-400'}`}>
                  {issue.priority}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 truncate">{issue.title}</p>
                  <p className="text-xs text-gray-500 font-mono">{issue.issueKey}</p>
                </div>
                <span className="text-[10px] text-gray-600 shrink-0 mt-0.5 capitalize">{issue.status}</span>
              </button>
            ))}
          </div>
        )}

        {open && results.length === 0 && query.length >= 2 && !loading && (
          <div className="absolute right-0 top-full mt-1.5 w-72 bg-gray-900 border border-gray-700 rounded-lg shadow-xl px-4 py-3 z-50">
            <p className="text-sm text-gray-500">No issues found for "{query}"</p>
          </div>
        )}
      </div>
    </header>
  );
}

export default Header;
