import { Link } from 'react-router-dom';

interface Breadcrumb {
  label: string;
  href?: string;
}

interface HeaderProps {
  title: string;
  breadcrumbs?: Breadcrumb[];
}

function Header({ title, breadcrumbs }: HeaderProps) {
  return (
    <header className="h-16 border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm flex items-center justify-between px-6 sticky top-0 z-20">
      <div className="flex flex-col justify-center">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1.5 text-xs text-gray-500 mb-0.5">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span>/</span>}
                {crumb.href ? (
                  <Link
                    to={crumb.href}
                    className="hover:text-gray-300 transition-colors"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-gray-400">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-lg font-semibold text-white leading-tight">
          {title}
        </h1>
      </div>

      {/* Search */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
        <input
          type="text"
          placeholder="Search..."
          className="w-64 pl-9 pr-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
        />
      </div>
    </header>
  );
}

export default Header;
