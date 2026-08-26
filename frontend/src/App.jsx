import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import TeamBrowsePage from './pages/TeamBrowsePage';
import TeamDetailPage from './pages/TeamDetailPage';
import PlayerBrowsePage from './pages/PlayerBrowsePage';
import PlayerDetailPage from './pages/PlayerDetailPage';
import NotFoundPage from './pages/NotFoundPage';

// Route tree mirrors the 5-screen inventory from
// docs/vibe-coding-checklist.md Phase 4 exactly: Login is public; every
// other screen sits behind ProtectedRoute + the shared Layout (nav shell).
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/teams" replace />} />
          <Route path="teams" element={<TeamBrowsePage />} />
          <Route path="teams/:teamId" element={<TeamDetailPage />} />
          <Route path="players" element={<PlayerBrowsePage />} />
          <Route path="players/:playerId" element={<PlayerDetailPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
