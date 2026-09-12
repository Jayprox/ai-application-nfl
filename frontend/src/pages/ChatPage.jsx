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
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Chat</h1>
      <p className="text-sm text-slate-500 mb-4">
        The research assistant — calls the same rankings, edge, insights, picks, and leaderboard data as the other
        tabs, answers only from what those return.
      </p>

      <div className="flex-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-4 space-y-3">
        {messages.length === 0 && <p className="text-sm text-slate-400">{WELCOME}</p>}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-900'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && <p className="text-sm text-slate-400">Thinking…</p>}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Who are the top rushing matchups this week?"
          rows={1}
          className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !input.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
