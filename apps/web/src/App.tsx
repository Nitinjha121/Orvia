import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { AuthScreen } from './components/AuthScreen';
import { Shell } from './components/Shell';
import { InterviewPage } from './components/InterviewPage';
import { ProfilePage } from './components/ProfilePage';
import { HistoryPage } from './components/HistoryPage';
import { SessionReportPage } from './components/SessionReportPage';
import { ProgressPage } from './components/ProgressPage';
import { FeedPage } from './components/FeedPage';
import { loadPlaybookPage } from './lib/playbookPage';

/** On demand: only someone opening the plan pays for its rules and charts. */
const PlanPage = lazy(() => import('./components/PlanPage').then((m) => ({ default: m.PlanPage })));
const StudyPage = lazy(() => import('./components/StudyPage').then((m) => ({ default: m.StudyPage })));
const loadPlaybook = loadPlaybookPage;
const PlaybookPage = loadPlaybook && lazy(() => loadPlaybook().then((m) => ({ default: m.PlaybookPage })));
const LoopPage = lazy(() => import('./components/LoopPage').then((m) => ({ default: m.LoopPage })));
const pageFallback = <p className="text-sm text-fg-muted">Loading…</p>;

function Gate() {
  const { user, loading } = useAuth();

  // Held until the cookie check resolves, otherwise a signed-in user is
  // flashed the sign-in form on every page load.
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <p className="text-sm text-fg-subtle">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
        <AuthScreen />
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<InterviewPage />} />
        <Route path="feed" element={<FeedPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="plan" element={<Suspense fallback={pageFallback}><PlanPage /></Suspense>} />
        <Route path="loop/:id" element={<Suspense fallback={pageFallback}><LoopPage /></Suspense>} />
        <Route path="study" element={<Suspense fallback={pageFallback}><StudyPage /></Suspense>} />
        {PlaybookPage && <Route path="playbook" element={<Suspense fallback={pageFallback}><PlaybookPage /></Suspense>} />}
        <Route path="progress" element={<ProgressPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="session/:id" element={<SessionReportPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
