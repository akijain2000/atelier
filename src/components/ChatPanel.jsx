import { useRef } from 'react';
import MarkdownText from './MarkdownText.jsx';

export default function ChatPanel({
  conversation,
  messages,
  draft,
  setDraft,
  onSend,
  isSending,
  error,
}) {
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const composerRef = useRef(null);

  function handleSubmit(e) {
    e.preventDefault();
    if (!draft.trim() || isSending) return;
    onSend(draft.trim());
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  if (!conversation) {
    return (
      <main className="chat-panel">
        <div className="chat-card">
          <div className="empty-state">
            <h3>Select or create a conversation</h3>
            <p>Choose from the sidebar or start a new inquiry.</p>
          </div>
        </div>
      </main>
    );
  }

  const property = conversation.property || conversation.listing_id || 'Unknown property';

  return (
    <main className="chat-panel">
      <div className="chat-card">
        <header className="chat-header">
          <div>
            <div className="eyebrow">Tenant Conversation</div>
            <h2>{conversation.tenant_name || 'New Inquiry'}</h2>
            <p className="chat-meta">
              {property} &bull; {messages.length} messages
            </p>
          </div>
        </header>

        <section
          className="messages"
          aria-live="polite"
          role="log"
          ref={messagesContainerRef}
        >
          {messages.length ? (
            messages.map((msg) => (
              <article
                key={msg.id}
                className={`message-bubble ${
                  msg.role === 'tenant' || msg.role === 'admin' ? 'user' : 'assistant'
                }`}
              >
                <div className="message-head">
                  <span className="message-role">
                    {msg.role === 'tenant'
                      ? 'Tenant'
                      : msg.role === 'admin'
                        ? 'Admin'
                        : 'AI Concierge ★'}
                  </span>
                  {msg.model && <span className="message-model">{msg.model}</span>}
                </div>
                <MarkdownText content={msg.content} />
              </article>
            ))
          ) : (
            <div className="empty-state">
              <h3>Start the conversation</h3>
              <p>
                Type or paste the tenant's Finn.no message below.
              </p>
            </div>
          )}

          {isSending && (
            <div className="message-bubble assistant pending">
              <div className="message-head">
                <span className="message-role">AI Concierge ★</span>
              </div>
              <p>Thinking through the response...</p>
            </div>
          )}

          <div ref={messagesEndRef} />
        </section>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type the tenant's message..."
            rows={3}
            ref={composerRef}
            onKeyDown={handleKeyDown}
          />
          <div className="composer-actions">
            <div className="composer-meta">
              <span className="status-pill small ready">Anthropic ready</span>
              <span className="helper-text">
                Press Enter to send, Shift+Enter for new line
              </span>
            </div>
            <button
              className="primary-button"
              type="submit"
              disabled={!draft.trim() || isSending}
            >
              {isSending ? 'Sending...' : 'Send message'}
            </button>
          </div>
        </form>

        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
