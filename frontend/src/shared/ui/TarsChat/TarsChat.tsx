import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Fab from '@mui/material/Fab';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import SmartToyIcon from '@mui/icons-material/SmartToy';

const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? '/api';

type Role = 'user' | 'assistant';
interface ChatMessage { role: Role; content: string; }

const SUGGESTIONS = [
  'How does the AI trade?', 'What is NAV?',
  'How is brokerage calculated?', 'What signals are used?', 'How do I read P&L?',
];

const WELCOME: ChatMessage = {
  role: 'assistant',
  content: "I'm TARS — the AI assistant powering QuantumMind.\n\nHumor setting: 75%. Ask me anything about how this system works.",
};

export const TarsChat = () => {
  const [isOpen,    setIsOpen]    = useState(false);
  const [messages,  setMessages]  = useState<ChatMessage[]>([WELCOME]);
  const [input,     setInput]     = useState('');
  const [isTyping,  setIsTyping]  = useState(false);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);

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
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);
    try {
      const res  = await fetch(`${API_BASE}/tars/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history: messages.slice(-10).map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply ?? 'Hmm. That did not compute. Try again.' }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection issue. Check your network and try again.' }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <>
      <Fab
        color="secondary"
        size="medium"
        onClick={() => setIsOpen(o => !o)}
        title="Chat with TARS"
        aria-label="Open TARS chatbot"
        sx={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1300 }}
      >
        <SmartToyIcon />
      </Fab>

      {isOpen && (
        <Paper
          elevation={8}
          role="dialog"
          aria-label="TARS AI Assistant"
          sx={{
            position: 'fixed', bottom: 80, right: 24, zIndex: 1300,
            width: 360, height: 480, display: 'flex', flexDirection: 'column',
            border: '1px solid', borderColor: 'divider',
          }}
        >
          {/* Header */}
          <Box display="flex" alignItems="center" gap={1.5} p={1.5} borderBottom="1px solid" borderColor="divider">
            <Box sx={{ width: 32, height: 32, borderRadius: '50%', bgcolor: 'secondary.dark', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <SmartToyIcon sx={{ fontSize: '1rem', color: 'secondary.light' }} />
            </Box>
            <Box flex={1}>
              <Typography variant="body2" fontWeight={700}>TARS</Typography>
              <Typography variant="caption" color="success.main">● Online · QuantumMind AI</Typography>
            </Box>
            <IconButton size="small" onClick={() => setIsOpen(false)} aria-label="Close">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>

          {/* Messages */}
          <Box flex={1} overflow="auto" p={1.5} display="flex" flexDirection="column" gap={1}>
            {messages.map((m, i) => (
              <Box key={i} alignSelf={m.role === 'user' ? 'flex-end' : 'flex-start'} maxWidth="85%">
                <Box
                  sx={{
                    px: 1.5, py: 1, borderRadius: m.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                    bgcolor: m.role === 'user' ? 'primary.dark' : 'rgba(255,255,255,0.06)',
                    border: '1px solid',
                    borderColor: m.role === 'user' ? 'primary.main' : 'divider',
                  }}
                >
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{m.content}</Typography>
                </Box>
              </Box>
            ))}
            {isTyping && (
              <Box alignSelf="flex-start">
                <Box sx={{ px: 1.5, py: 1, borderRadius: '12px 12px 12px 2px', bgcolor: 'rgba(255,255,255,0.06)', border: '1px solid', borderColor: 'divider', display: 'flex', gap: 0.5, alignItems: 'center' }}>
                  {[0, 1, 2].map(i => (
                    <Box key={i} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'text.secondary', animation: `bounce 1.2s ${i * 0.2}s infinite`, '@keyframes bounce': { '0%,80%,100%': { transform: 'scale(0)' }, '40%': { transform: 'scale(1)' } } }} />
                  ))}
                </Box>
              </Box>
            )}
            <div ref={bottomRef} />
          </Box>

          {/* Quick suggestions */}
          {messages.length === 1 && (
            <>
              <Divider />
              <Box p={1} display="flex" gap={0.5} flexWrap="wrap">
                {SUGGESTIONS.map(s => (
                  <Chip key={s} label={s} size="small" clickable variant="outlined" onClick={() => void sendMessage(s)}
                    sx={{ fontSize: '0.65rem', height: 22 }} />
                ))}
              </Box>
            </>
          )}

          {/* Input */}
          <Divider />
          <Box display="flex" alignItems="center" gap={1} p={1}>
            <TextField
              inputRef={inputRef}
              fullWidth size="small" placeholder="Ask TARS anything..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(input); } }}
              multiline maxRows={3}
              sx={{ '& .MuiOutlinedInput-root': { fontSize: '0.82rem' } }}
            />
            <IconButton
              color="primary" size="small"
              disabled={!input.trim() || isTyping}
              onClick={() => void sendMessage(input)}
              aria-label="Send"
            >
              <SendIcon fontSize="small" />
            </IconButton>
          </Box>
        </Paper>
      )}
    </>
  );
};
