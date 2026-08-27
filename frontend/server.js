/**
 * Chalk That NFL — frontend production server
 * =========================================================================
 * Serves the static build (`dist/`, produced by `vite build`) on Railway.
 * A plain static file server isn't quite enough for a client-routed SPA:
 * a hard refresh (or a shared link) on e.g. /players/:id has to resolve
 * to index.html so react-router-dom can take over client-side, rather
 * than 404ing on a path that only exists in the browser's history.
 *
 * Express, not a dedicated static-hosting tool, to match the rest of the
 * stack (backend-api is already Express) rather than introducing a
 * second server pattern just for this one service.
 * =========================================================================
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

const app = express();
app.use(express.static(distDir));

// SPA fallback — anything not matched by a real file in dist/ (e.g. a
// direct hit on /teams/78 or /players/<uuid>) serves index.html so
// react-router-dom's client-side routing resolves it, not a 404.
app.get('*', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`[web] chalk-that-nfl-web serving dist/ on :${PORT}`);
});
