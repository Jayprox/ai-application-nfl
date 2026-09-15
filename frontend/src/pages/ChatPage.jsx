import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, AuthError } from '../api/client';
import { useAuth } from '../context/AuthContext';

/**
 * Chat page — frontend surface for the orchestrator/chat agent (POST
 * /chat, backend/lib/orchestrator.js). Part 2 Phase 2's 5th agent,
 * deliberately read-only in v1: it answers questions by calling the same
 * rankings/edge/insights/picks/leaderboard data every other tab already
 * uses, but never generates or logs a new pick itself (that's still only
 * POST /portfolio/slate).
 *
 * Stateless on the client too — conversation lives only in this
 * component's state, sent in full (bounded to MAX_HISTORY, matching the
 * backend's own trim) with every message, and gone on refresh. No new
 * persistence in v1, same choice the backend route makes.
 */

const MAX_HISTORY = 12;
const WELCOME =
  "Ask about matchup rankings, model-vs-market edges, player insights, or how the agents are grading out — I only answer from real computed data, and I can't generate or log a pick myself (that's the Picks tab).";

// ---------------------------------------------------------------------
// Minimal markdown rendering for assistant replies.
//
// The model's own formatting choice isn't deterministic — the exact same
// underlying edge data has come back as a bulleted list in one reply and
// a GFM-style pipe table in another (both correct, just styled
// differently by the model). Without this, either style shows up as raw
// "**"/"|" characters since the bubble below used to render plain text.
// Hand-rolled on purpose rather than pulling in react-markdown or
// similar — same "no new dependency that needs an npm install before it
// can be tested" reasoning as lib/rate-limit.js and orchestrator.js's
// own fetch-over-SDK choice; this only needs to cover the handful of
// markdown constructs the model actually reaches for (bold, bullet/
// numbered lists, simple tables), not the full spec.
// ---------------------------------------------------------------------

function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{part}</span>
    )
  );
}

function isTableSeparatorLine(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderMarkdownBlock(block, blockIndex) {
  const lines = block.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  // A header row followed by a "---|---" separator row = a pipe table.
  if (lines.length >= 2 && lines[0].includes('|') && isTableSeparatorLine(lines[1])) {
    const header = parseTableRow(lines[0]);
    const rows = lines.slice(2).map(parseTableRow);
    return (
      <div key={blockIndex} className="overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th key={i} className="border-b border-line px-2 py-1 text-left font-semibold">
                  {renderInline(cell, `h${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} className="border-b border-line px-2 py-1 align-top">
                    {renderInline(cell, `r${ri}c${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Every line starts with "- "/"* " or "1. " → a list.
  const bulletRe = /^\s*[-*]\s+(.*)$/;
  const numberedRe = /^\s*\d+\.\s+(.*)$/;
  if (lines.every((l) => bulletRe.test(l) || numberedRe.test(l))) {
    const ordered = numberedRe.test(lines[0]);
    const ListTag = ordered ? 'ol' : 'ul';
    return (
      <ListTag key={blockIndex} className={ordered ? 'list-decimal pl-5 space-y-0.5' : 'list-disc pl-5 space-y-0.5'}>
        {lines.map((l, i) => {
          const m = l.match(bulletRe) || l.match(numberedRe);
          return <li key={i}>{renderInline(m[1], `li${i}`)}</li>;
        })}
      </ListTag>
    );
  }

  // Otherwise a plain paragraph — preserve line breaks within the block.
  return (
    <p key={blockIndex}>
      {lines.map((l, i) => (
        <span key={i}>
          {renderInline(l, `p${i}`)}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  );
}

function renderMarkdown(content) {
  const blocks = content.split(/\n\s*\n/);
  return <div className="space-y-2">{blocks.map((b, i) => renderMarkdownBlock(b, i))}</div>;
}

export default function ChatPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const { logout } = useAuth();
  const navigate = useNavigate();
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const next = [...messages, { role: 'user', content: text }].slice(-MAX_HISTORY);
    setMessages(next);
    setInput('');
    setError(null);
    setSending(true);

    try {
      const res = await apiFetch('/chat', { method: 'POST', body: { messages: next } });
      setMessages((prev) => [...prev, res.data]);
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      setError(err.message || 'Something went wrong');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 8rem)' }}>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">Chat</h1>
      <p className="text-sm text-ink-dim mb-4">
        The research assistant — calls the same rankings, edge, insights, picks, and leaderboard data as the other
        tabs, answers only from what those return.
      </p>

      <div className="flex-1 overflow-y-auto rounded-md border border-line bg-surface p-4 space-y-3">
        {messages.length === 0 && <p className="text-sm text-ink-faint">{WELCOME}</p>}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'whitespace-pre-wrap bg-accent text-on-accent' : 'bg-surface-2 text-ink'
              }`}
            >
              {m.role === 'assistant' ? renderMarkdown(m.content) : m.content}
            </div>
          </div>
        ))}
        {sending && <p className="text-sm text-ink-faint">Thinking…</p>}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mt-2 text-sm text-negative">{error}</p>}

      <div className="mt-3 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Who are the top rushing matchups this week?"
          aria-label="Chat message"
          rows={1}
          className="flex-1 resize-none rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !input.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
