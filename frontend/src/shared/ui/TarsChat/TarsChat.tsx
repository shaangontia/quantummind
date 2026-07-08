import { useEffect, useRef, useState } from 'react';
import './TarsChat.css';

const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? '/api';

type Role = 'user' | 'assistant';

interface ChatMessage {
  role: Role;
  content: string;
}

const SUGGESTIONS = [
  'How does the AI trade?',
  'What is NAV?',
  'How is brokerage calculated?',
  'What signals are used?',
  'How do I read P&L?',
];

const WELCOME: ChatMessage = {
  role: 'assistant',
  content: "I'm TARS — the AI assistant powering QuantumMind.\n\nHumor setting: 75%. Ask me anything about how this system works.",
};

export const TarsChat = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      inputRef.current?.focus();
    }
  }, [isOpen, messages]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isTyping) return;

    const userMsg: ChatMessage = { role: 'user', content: trimmed };
    const updatedHistory = [...messages, userMsg];
    setMessages(updatedHistory);
    setInput('');
    setIsTyping(true);

    try {
      const res = await fetch(`${API_BASE}/tars/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      const reply = data.reply ?? 'Hmm. That did not compute. Try again.';
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection issue. Check your network and try again.' }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  return (
    <>
      <button
        className="tars-trigger"
        onClick={() => setIsOpen(o => !o)}
        title="Chat with TARS"
        aria-label="Open TARS chatbot"
      >
        🤖
      </button>

      {isOpen && (
        <div className="tars-panel" role="dialog" aria-label="TARS AI Assistant">
          {/* Header */}
          <div className="tars-header">
            <div className="tars-header-info">
              <div className="tars-avatar">🤖</div>
              <div>
                <div className="tars-name">TARS</div>
                <div className="tars-subtitle">● Online · QuantumMind AI</div>
              </div>
            </div>
            <button className="tars-close" onClick={() => setIsOpen(false)} aria-label="Close">✕</button>
          </div>

          {/* Messages */}
          <div className="tars-messages">
            {messages.map((m, i) => (
              <div key={i} className={`tars-message ${m.role}`}>
                <div className="tars-bubble">{m.content}</div>
              </div>
            ))}
            {isTyping && (
              <div className="tars-message assistant">
                <div className="tars-typing">
                  <span className="tars-dot" />
                  <span className="tars-dot" />
                  <span className="tars-dot" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Quick suggestions (only when fresh) */}
          {messages.length === 1 && (
            <div className="tars-suggestions">
              {SUGGESTIONS.map(s => (
                <button key={s} className="tars-suggestion" onClick={() => void sendMessage(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="tars-input-row">
            <textarea
              ref={inputRef}
              className="tars-input"
              rows={1}
              placeholder="Ask TARS anything..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="tars-send"
              disabled={!input.trim() || isTyping}
              onClick={() => void sendMessage(input)}
              aria-label="Send"
            >
              ➤
            </button>
          </div>
        </div>
      )}
    </>
  );
};
