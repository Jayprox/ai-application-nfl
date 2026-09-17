import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import BoardPage from './pages/BoardPage';
import GamesPage from './pages/GamesPage';
import GameDetailPage from './pages/GameDetailPage';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import TeamBrowsePage from './pages/TeamBrowsePage';
import TeamDetailPage from './pages/TeamDetailPage';
import PlayerBrowsePage from './pages/PlayerBrowsePage';
import PlayerDetailPage from './pages/PlayerDetailPage';
import PicksPage from './pages/PicksPage';
import LeaderboardPage from './pages/LeaderboardPage';
import RankingsPage from './pages/RankingsPage';
import PropsPage from './pages/PropsPage';
import EdgePage from './pages/EdgePage';
import PortfolioPage from './pages/PortfolioPage';
import ChatPage from './pages/ChatPage';
import NotFoundPage from './pages/NotFoundPage';

// Route tree mirrors the 5-screen inventory from
// docs/vibe-coding-checklist.md Phase 4 exactly: Login is public; every
// other screen sits behind ProtectedRoute + the shared Layout (nav shell).
// PicksPage (Part 2's first user-facing surface) added on top of the
// original 5 — read-only wiring against the existing picks_log routes.
// BoardPage (2026-09-14, docs/part2-roadmap.md's "Slate/Board/Game"
// vision) is now the index redirect target instead of /games — a
// curated front door composed from the pages already below it, see
// BoardPage.jsx's own header comment.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/board" replace />} />
          <Route path="board" element={<BoardPage />} />
          <Route path="games" element={<GamesPage />} />
          <Route path="games/:gameId" element={<GameDetailPage />} />
          <Route path="teams" element={<TeamBrowsePage />} />
          <Route path="teams/:teamId" element={<TeamDetailPage />} />
          <Route path="players" element={<PlayerBrowsePage />} />
          <Route path="players/:playerId" element={<PlayerDetailPage />} />
          <Route path="picks" element={<PicksPage />} />
          <Route path="leaderboard" element={<LeaderboardPage />} />
          <Route path="rankings" element={<RankingsPage />} />
          <Route path="props" element={<PropsPage />} />
          <Route path="edge" element={<EdgePage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="chat" element={<ChatPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
