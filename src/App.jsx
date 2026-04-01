import { useEffect, useRef, useState } from 'react';
import ConversationList from './components/ConversationList.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import ListingSelector from './components/ListingSelector.jsx';
import ScoringSidebar from './components/ScoringSidebar.jsx';

function App() {
  const [conversations, setConversations] = useState([]);
  const [activeConvoId, setActiveConvoId] = useState(null);
  const [activeConvo, setActiveConvo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [selectedListing, setSelectedListing] = useState(null);
  const [latestScore, setLatestScore] = useState(null);
  const [isScoring, setIsScoring] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const pollRef = useRef(null);
  const scorePollRef = useRef(null);

  useEffect(() => {
    loadConversations().finally(() => setIsBooting(false));
  }, []);

  useEffect(() => {
    if (activeConvoId) {
      loadConversation(activeConvoId);
    } else {
      setActiveConvo(null);
      setMessages([]);
      setLatestScore(null);
      setIsScoring(false);
    }
    return () => clearInterval(scorePollRef.current);
  }, [activeConvoId]);

  useEffect(() => {
    if (!activeConvoId) return;
    pollRef.current = setInterval(() => loadConversations(), 15000);
    return () => clearInterval(pollRef.current);
  }, [activeConvoId]);

  async function loadConversations() {
    try {
      const res = await fetch('/api/conversations');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setConversations(data);
    } catch {}
  }

  async function loadConversation(id) {
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setActiveConvo(data);
      setMessages(data.messages || []);
      setLatestScore(data.latestScore || null);
      setSelectedListing(data.listing_id);

      if (data.latestScore?.scoring_status === 'pending') {
        setIsScoring(true);
        startScorePolling(id);
      } else {
        setIsScoring(false);
      }
    } catch {}
  }

  async function createConversation() {
    if (!selectedListing) {
      setError('Select a listing first.');
      return;
    }

    setError('');
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listing_id: selectedListing }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Could not create conversation.');
      }

      const convo = await res.json();
      await loadConversations();
      setActiveConvoId(convo.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function sendMessage(content) {
    if (!activeConvoId || !content.trim()) return;

    setIsSending(true);
    setError('');

    try {
      const res = await fetch(`/api/conversations/${activeConvoId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, role: 'tenant' }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send message.');

      setDraft('');
      await loadConversation(activeConvoId);
      await loadConversations();

      if (data.autoScoreTriggered) {
        setIsScoring(true);
        startScorePolling(activeConvoId);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSending(false);
    }
  }

  async function triggerScore() {
    if (!activeConvoId || isScoring) return;

    setIsScoring(true);
    try {
      const res = await fetch(`/api/conversations/${activeConvoId}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        setIsScoring(false);
        return;
      }
      startScorePolling(activeConvoId);
    } catch {
      setIsScoring(false);
    }
  }

  function startScorePolling(convoId) {
    clearInterval(scorePollRef.current);
    scorePollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/conversations/${convoId}`);
        if (!res.ok) return;
        const data = await res.json();
        const score = data.latestScore;

        if (score && score.scoring_status !== 'pending') {
          clearInterval(scorePollRef.current);
          setLatestScore(score);
          setIsScoring(false);
          await loadConversations();
        }
      } catch {}
    }, 3000);
  }

  return (
    <div className="app-frame">
      <nav className="top-nav-shell">
        <div className="top-nav-main">
          <div className="top-nav-brand">
            <span className="brand-badge">A</span>
            <div>
              <span className="brand-title">Atelier</span>
              <p className="brand-copy">Tenant chat &amp; lead scoring</p>
            </div>
          </div>
          <ListingSelector
            selectedListing={selectedListing}
            onSelect={setSelectedListing}
          />
        </div>
      </nav>

      <div className="atelier-layout">
        <ConversationList
          conversations={conversations}
          activeId={activeConvoId}
          onSelect={setActiveConvoId}
          onCreate={createConversation}
        />

        <ChatPanel
          conversation={activeConvo}
          messages={messages}
          draft={draft}
          setDraft={setDraft}
          onSend={sendMessage}
          isSending={isSending}
          error={error}
        />

        <ScoringSidebar
          conversationId={activeConvoId}
          latestScore={latestScore}
          onScore={triggerScore}
          isScoring={isScoring}
        />
      </div>
    </div>
  );
}

export default App;
