import { NavLink, Outlet } from 'react-router-dom';
import { applyTheme, type ThemeName } from '@orvia/theme';
import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { HAS_PLAYBOOK } from '../lib/playbookPage';

const NAV = [
  { to: '/', label: 'Interview', end: true },
  { to: '/plan', label: 'Plan' },
  { to: '/feed', label: 'Feed' },
  { to: '/study', label: 'Study' },
  ...(HAS_PLAYBOOK ? [{ to: '/playbook', label: 'Playbook' }] : []),
  { to: '/progress', label: 'Progress' },
  { to: '/history', label: 'History' },
  { to: '/profile', label: 'Profile' },
];

export function Shell() {
  const { user, signOut } = useAuth();
  const [theme, setTheme] = useState<ThemeName>('system');
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        {/*
          One row on a laptop, two on a phone. The nav is ordered BETWEEN the
          brand and the account controls at `sm` and after both below it, so
          wrapping puts the five links on their own full-width line rather than
          squeezing them against a theme switcher that cannot shrink.
        */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-5 sm:py-3">
          <span className="order-1 text-base font-semibold tracking-tight text-fg">Orvia</span>

          {/* min-w-0 so the nav may shrink: without it the flex item keeps its
              content width and the whole PAGE scrolls sideways on a phone. */}
          <nav className="order-3 flex w-full min-w-0 gap-1 overflow-x-auto sm:order-2 sm:w-auto">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}
                className={({ isActive }) =>
                  `shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive ? 'bg-surface-alt text-fg' : 'text-fg-muted hover:text-fg'
                  }`}>
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="order-2 ml-auto flex items-center gap-2 sm:order-3 sm:gap-3">
            <div role="group" aria-label="Theme" className="flex gap-1 rounded-md bg-surface-alt p-1">
              {(['light', 'system', 'dark'] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTheme(t)} aria-pressed={theme === t}
                  className={`rounded px-2 py-1 text-xs font-medium capitalize transition-colors ${
                    theme === t ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}>
                  {t}
                </button>
              ))}
            </div>
            <span className="hidden text-sm text-fg-muted sm:inline">{user?.name}</span>
            <button onClick={() => void signOut()}
                    className="shrink-0 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:text-fg sm:px-2.5">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
