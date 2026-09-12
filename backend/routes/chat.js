/**
 * Chalk That NFL — chat route
 * =========================================================================
 * POST /chat  { messages: [{ role: 'user'|'assistant', content: string }] }
 *             -> { data: { role: 'assistant', content: string } }
 *
 * Thin HTTP wrapper over lib/orchestrator.js's tool-calling loop — see
 * that file's header for the actual agent design (read-only v1, no pick
 * generation, Anthropic Messages API called directly over fetch).
 *
 * Stateless: the client sends the whole visible conversation every time
 * (same pattern as any plain chat API) rather than this route keeping
 * server-side session state — no new DB table for conversations in v1.
 * MAX_HISTORY bounds how much of that the model actually sees, so a long
 * conversation doesn't grow the token cost of every subsequent message.
 * =========================================================================
 */

const express = require('express');
const { runChat } = require('../lib/orchestrator');
const { createRateLimiter } = require('../lib/rate-limit');

const router = express.Router();

const MAX_HISTORY = 12;
const MAX_MESSAGE_LENGTH = 2000;

// A real conversation is naturally slower-paced than this (each reply
// involves at least one LLM round-trip, often several tool calls) — this
// mainly exists to bound cost if a client bug or a bored user starts
// firing messages in a loop.
const chatLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many chat messages — try again in a few minutes.',
});

router.post('/', chatLimiter, async (req, res) => {
  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages (a non-empty array) is required' });
  }
  for (const m of messages) {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      return res.status(400).json({ error: 'each message must be { role: "user"|"assistant", content: string }' });
    }
    if (m.content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `message content must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }
  }

  const trimmed = messages.slice(-MAX_HISTORY);
  if (trimmed[trimmed.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'the last message must have role "user"' });
  }

  try {
    const { reply } = await runChat(trimmed);
    res.json({ data: { role: 'assistant', content: reply } });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      console.error('[routes/chat] misconfigured:', err.message);
      return res.status(503).json({ error: 'Chat is not set up yet — ANTHROPIC_API_KEY is missing.' });
    }
    console.error('[routes/chat] failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
