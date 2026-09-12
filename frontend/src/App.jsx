import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import TeamBrowsePage from './pages/TeamBrowsePage';
import TeamDetailPage from './pages/TeamDetailPage';
import PlayerBrowsePage from './pages/PlayerBrowsePage';
import PlayerDetailPage from './pages/PlayerDetailPage';
import PicksPage from './pages/PicksPage';
import LeaderboardPage from './pages/LeaderboardPage';
import RankingsPage from './pages/RankingsPage';
import EdgePage from './pages/EdgePage';
import ChatPage from './pages/ChatPage';
import NotFoundPage from './pages/NotFoundPage';

// Route tree mirrors the 5-screen inventory from
// docs/vibe-coding-checklist.md Phase 4 exactly: Login is public; every
// other screen sits behind ProtectedRoute + the shared Layout (nav shell).
// PicksPage (Part 2's first user-facing surface) added on top of the
// original 5 — read-only wiring against the existing picks_log routes.
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
          <Route path="picks" element={<PicksPage />} />
          <Route path="leaderboard" element={<LeaderboardPage />} />
          <Route path="rankings" element={<RankingsPage />} />
          <Route path="edge" element={<EdgePage />} />
          <Route path="chat" element={<ChatPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
