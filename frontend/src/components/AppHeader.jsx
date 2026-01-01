import React from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { IconLogOut } from './Icons.jsx';

export default function AppHeader({
  onLogout,
  darkMode = false,
  extraActions = null,
}) {
  const { logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    onLogout?.();
  };

  return (
    <header className="w-full border-b bg-gray-100 border-gray-200">
      <nav className="flex justify-between items-center px-6 py-3">
        {/* App title */}
        <h1 className="font-bold text-2xl text-black">
          Soch AI
        </h1>

        {/* Right side */}
        <div className="flex items-center gap-4">
          {/* Page-specific actions (profile, team, etc.) */}
          {extraActions}

          {/* Logout (global & consistent) */}
          <button
            onClick={handleLogout}
            className={`p-2 rounded-md transition-colors ${
              darkMode
                ? 'bg-zinc-900 text-white hover:bg-zinc-800'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
            aria-label="Logout"
            title="Logout"
          >
            <IconLogOut className="w-4 h-4" />
          </button>
        </div>
      </nav>
    </header>
  );
}
