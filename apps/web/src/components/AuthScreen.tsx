import { useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';

import { FIELD, LABEL } from './ui/styles';

export function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'in') await signIn(email, password);
      else await signUp(name, email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Orvia</h1>
        <p className="mt-1.5 text-sm text-fg-muted">
          {mode === 'in' ? 'Sign in to continue practising.' : 'Create an account to save your progress.'}
        </p>
      </header>

      <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-sm">
        {mode === 'up' && (
          <div>
            <label className={LABEL} htmlFor="name">Name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)}
                   className={FIELD} autoComplete="name" required />
          </div>
        )}
        <div>
          <label className={LABEL} htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                 className={FIELD} autoComplete="email" required />
        </div>
        <div>
          <label className={LABEL} htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                 className={FIELD} autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                 minLength={8} required />
          {mode === 'up' && <p className="mt-1.5 text-xs text-fg-subtle">At least 8 characters.</p>}
        </div>

        {error && (
          <div className="rounded-md border border-danger bg-danger-muted px-3 py-2">
            <p className="text-sm text-fg">{error}</p>
          </div>
        )}

        <button type="submit" disabled={busy}
                className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg
                           transition-opacity hover:opacity-90 disabled:opacity-40">
          {busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-fg-muted">
        {mode === 'in' ? "Don't have an account? " : 'Already have one? '}
        <button onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}
                className="font-medium text-brand hover:underline">
          {mode === 'in' ? 'Sign up' : 'Sign in'}
        </button>
      </p>
    </div>
  );
}
