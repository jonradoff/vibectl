import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setStoredToken, authMe } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

/**
 * Handles the GitHub OAuth callback redirect.
 * The backend sends the user to /auth/callback?token=... or /auth/callback?error=...
 */
export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { recheck } = useAuth();
  const [error, setError] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    const errMsg = searchParams.get('error');

    if (errMsg) {
      setError(decodeURIComponent(errMsg));
      return;
    }

    if (token) {
      setStoredToken(token);
      // Verify token and check if password change is required
      authMe()
        .then(() => recheck())
        .then(() => navigate('/', { replace: true }))
        .catch(() => setError('Authentication failed. Please try again.'));
    } else {
      setError('No token received from GitHub.');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    const isAccessDenied = error.toLowerCase().includes('not been added') || error.toLowerCase().includes('ask your admin');
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4 ${isAccessDenied ? 'bg-amber-500/20' : 'bg-red-600/20'}`}>
            {isAccessDenied ? (
              <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            ) : (
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            )}
          </div>
          <p className="text-white font-medium mb-2">
            {isAccessDenied ? 'Access not authorized' : 'GitHub login failed'}
          </p>
          <p className="text-gray-400 text-sm mb-6">{error}</p>
          <button
            onClick={() => navigate('/', { replace: true })}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400 text-sm">Signing you in…</p>
      </div>
    </div>
  );
}
