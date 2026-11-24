import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MessageSquare, Send, Smile } from 'lucide-react';
import { useScopeMessages, scopeKey, useWorkspace } from '@/state/workspace';
import { useDismiss } from '@/lib/model';
import { clockTime, dayLabel } from '@/lib/format';
import { Avatar, EmptyState, Spinner } from '@/components/ui';
import { MAX_MESSAGE_LENGTH, type Message, type MessageScope } from '@/lib/model';
import './chat.css';

interface ChatThreadProps {
  scopeType: MessageScope;
  scopeId: string;
  placeholder: string;
  emptyTitle?: string;
  emptyText?: string;
}

const EMOJI = [
  '😀', '😂', '😅', '😍', '😎', '🤔', '😭', '🔥',
  '💜', '👏', '👍', '👀', '🎮', '🕹️', '🏆', '⚡',
  '🎉', '🤝', '😤', '🫡', '💀', '🚀', '🌙', '✨',
];

export function ChatThread({
  scopeType,
  scopeId,
  placeholder,
  emptyTitle = 'No messages yet',
  emptyText = 'Send the first message to get this room talking.',
}: ChatThreadProps) {
  const messages = useScopeMessages(scopeType, scopeId);
  const loading = useWorkspace(
    (state) => state.loadingScopes[scopeKey(scopeType, scopeId)] ?? false,
  );
  const loadMessages = useWorkspace((state) => state.loadMessages);
  const sendMessage = useWorkspace((state) => state.sendMessage);
  const profile = useWorkspace((state) => state.profile);
  const epoch = useWorkspace((state) => state.epoch);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const emoji = useDismiss(emojiOpen, () => setEmojiOpen(false));

  useEffect(() => {
    void loadMessages(scopeType, scopeId);
  }, [scopeType, scopeId, loadMessages, epoch]);

  useEffect(() => {
    const node = listRef.current;
    if (node && stickToBottom.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length]);

  const groups = useMemo(() => groupByDay(messages), [messages]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await sendMessage(scopeType, scopeId, body);
    if (ok) {
      setDraft('');
      setEmojiOpen(false);
      stickToBottom.current = true;
    }
    setBusy(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="md-chat">
      <div
        className="md-chat__list"
        ref={listRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {loading && messages.length === 0 ? (
          <div className="md-chat__loading">
            <Spinner size={16} />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={20} />}
            title={emptyTitle}
            text={emptyText}
            compact
          />
        ) : (
          groups.map((group) => (
            <section key={group.label} className="md-chat__group">
              <div className="md-chat__day">
                <span>{group.label}</span>
              </div>
              {group.items.map((message, index) => {
                const previous = group.items[index - 1];
                const grouped =
                  previous !== undefined &&
                  previous.authorId === message.authorId &&
                  message.createdAt - previous.createdAt < 5 * 60_000;
                return (
                  <MessageRow
                    key={message.id}
                    message={message}
                    grouped={grouped}
                    color={message.authorId === profile?.id ? profile?.avatarColor : undefined}
                  />
                );
              })}
            </section>
          ))
        )}
      </div>

      <div className="md-composer">
        <div className="md-composer__field">
          <textarea
            className="md-composer__input"
            value={draft}
            rows={1}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />

          <div className="md-composer__actions">
            <div className="md-composer__emoji-wrap" ref={emoji.ref}>
              <button
                type="button"
                className="md-composer__icon"
                aria-label="Insert emoji"
                aria-expanded={emojiOpen}
                onClick={() => setEmojiOpen((open) => !open)}
              >
                <Smile size={17} />
              </button>
              {emojiOpen ? (
                <div className="md-emoji" role="dialog" aria-label="Emoji">
                  {EMOJI.map((glyph) => (
                    <button
                      key={glyph}
                      type="button"
                      className="md-emoji__item"
                      onClick={() => {
                        setDraft((value) => `${value}${glyph}`);
                        setEmojiOpen(false);
                      }}
                    >
                      {glyph}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="md-composer__send"
              aria-label="Send message"
              disabled={!draft.trim() || busy}
              onClick={() => void submit()}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  grouped,
  color,
}: {
  message: Message;
  grouped: boolean;
  color?: string;
}) {
  return (
    <article className="md-msg" data-grouped={grouped}>
      <div className="md-msg__avatar">
        {grouped ? null : <Avatar name={message.authorName} color={color} size={32} />}
      </div>
      <div className="md-msg__content">
        {grouped ? null : (
          <header className="md-msg__head">
            <span className="md-msg__author">{message.authorName}</span>
            <time className="md-msg__time" dateTime={new Date(message.createdAt).toISOString()}>
              {clockTime(message.createdAt)}
            </time>
          </header>
        )}
        <p className="md-msg__body">{message.body}</p>
      </div>
    </article>
  );
}

function groupByDay(messages: Message[]): Array<{ label: string; items: Message[] }> {
  const groups: Array<{ label: string; items: Message[] }> = [];
  for (const message of messages) {
    const label = dayLabel(message.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(message);
    } else {
      groups.push({ label, items: [message] });
    }
  }
  return groups;
}
