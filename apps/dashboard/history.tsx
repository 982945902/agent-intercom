import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskState, DeliveryState, MessageRecord, Session } from '../../packages/sdk/index.js';
import { historyPageSize, loadHistory, sdk, useResource } from './live.js';
import { deliveryLabels, kindLabels } from './message-labels.js';

const askLabels: Record<AskState, string> = {
  waiting: 'Waiting for reply',
  replied: 'Replied',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
};
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Timestamp({ value }: { value: number }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{dateFormat.format(date)}</time>;
}

function MessageStatus({ record }: { record: MessageRecord }) {
  const counts = new Map<DeliveryState, number>();
  for (const delivery of record.deliveries) {
    counts.set(delivery.state, (counts.get(delivery.state) ?? 0) + 1);
  }
  return (
    <span className="statuses">
      {Object.entries(deliveryLabels).map(([key, label]) => {
        const state = key as DeliveryState;
        const count = counts.get(state);
        return count ? <span className={`badge ${state}`} key={state}>{count} {label}</span> : null;
      })}
      {record.deliveries.length === 0 && <span className="badge">No recipients</span>}
      {record.message.askState && (
        <span className={`badge ${record.message.askState}`}>{askLabels[record.message.askState]}</span>
      )}
    </span>
  );
}

interface HistoryProps {
  groupId?: string;
  groupNames: ReadonlyMap<string, string>;
  sessions: ReadonlyMap<string, Session>;
  revision: number;
  messageId: string | null;
  onOpen: (messageId: string | null) => void;
}

export function History({ groupId, groupNames, sessions, revision, messageId, onOpen }: HistoryProps) {
  const [count, setCount] = useState(historyPageSize);
  const load = useCallback(() => loadHistory(groupId, count), [groupId, count]);
  const history = useResource(load, revision);
  const heading = useRef<HTMLHeadingElement>(null);
  const [openedMessage, setOpenedMessage] = useState<string | null>(null);
  const openedRow = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (messageId) back.current?.focus();
    else if (openedMessage) (openedRow.current ?? heading.current)?.focus();
  }, [messageId, openedMessage]);

  return (
    <section className="panel" aria-labelledby="history-heading">
      <header className="panel-heading">
        <h2 id="history-heading" ref={heading} tabIndex={-1}>{messageId ? 'Message details' : 'Message history'}</h2>
        {messageId && <button ref={back} type="button" className="button quiet" onClick={() => onOpen(null)}>
          <span aria-hidden="true">←</span> Back to history
        </button>}
      </header>
      {messageId ? (
        <MessageDetail key={messageId} {...{ messageId, groupNames, sessions, revision, onOpen }} />
      ) : (
        <>
          {history.error && (
            <div className="notice" role="alert">
              <span>{history.error}</span>
              <button className="button quiet" type="button" onClick={history.refresh}>Retry</button>
            </div>
          )}
          {history.data ? (
            history.data.records.length ? (
              <ol className="history-list" aria-label="Messages, newest first">
                {history.data.records.map(record => (
                  <li key={record.message.id}>
                    <button className="message-row" type="button" ref={openedMessage === record.message.id ? openedRow : undefined}
                      onClick={() => { setOpenedMessage(record.message.id); onOpen(record.message.id); }}>
                      <span className="message-row-heading">
                        <span className="message-sender">{record.message.fromName}</span>
                        <Timestamp value={record.message.createdAt} />
                      </span>
                      <span className="message-meta">
                        <strong>{kindLabels[record.message.kind]}</strong>
                        {!groupId && ` · ${groupNames.get(record.message.groupIdAtAccept) ?? record.message.groupIdAtAccept}`}
                      </span>
                      <span className="message-preview">{record.message.text}</span>
                      <MessageStatus record={record} />
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="empty-state">
                <span className="empty-icon message-icon" aria-hidden="true" />
                <p>No messages yet</p>
                <p>{groupId ? 'Messages sent in this group will appear here.' : 'Messages between joined sessions will appear here.'}</p>
              </div>
            )
          ) : history.loading && <p className="empty-state" role="status">Loading messages…</p>}
          {history.data?.nextBefore != null && (
            <footer className="panel-footer">
              <button className="button quiet" type="button" disabled={history.loading} onClick={() => setCount(count + historyPageSize)}>
                Load older messages
              </button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}

type MessageDetailProps = Pick<HistoryProps, 'groupNames' | 'sessions' | 'revision' | 'onOpen'> & { messageId: string };

function MessageDetail({ messageId, groupNames, sessions, revision, onOpen }: MessageDetailProps) {
  const load = useCallback(() => sdk.getMessage({ messageId }), [messageId]);
  const detail = useResource(load, revision);
  const record = detail.data;
  return (
    <div className="message-detail">
      {detail.error && (
        <div className="notice" role="alert">
          <span>{detail.error}</span>
          <button className="button quiet" type="button" onClick={detail.refresh}>Retry</button>
        </div>
      )}
      {record ? (
        <>
          <div className="detail-heading">
            <h3 title={record.message.fromSessionId}>{record.message.fromName}</h3>
            <Timestamp value={record.message.createdAt} />
          </div>
          <p className="message-meta">
            {kindLabels[record.message.kind]} · {groupNames.get(record.message.groupIdAtAccept) ?? record.message.groupIdAtAccept}
          </p>
          <p className="message-body">{record.message.text}</p>
          {record.message.replyTo && (
            <button className="button quiet" type="button" onClick={() => onOpen(record.message.replyTo)}>View original message</button>
          )}
          {record.message.askState && (
            <p><span className={`badge ${record.message.askState}`}>{askLabels[record.message.askState]}</span></p>
          )}
          <h4>Delivery status</h4>
          {record.deliveries.length ? (
            <ul className="deliveries">
              {record.deliveries.map(delivery => (
                <li key={delivery.id}>
                  <div className="delivery-heading">
                    <strong title={delivery.toSessionId}>{sessions.get(delivery.toSessionId)?.name ?? delivery.toSessionId}</strong>
                    <span className={`badge ${delivery.state}`}>{deliveryLabels[delivery.state]}</span>
                  </div>
                  <p className="message-meta">{delivery.source}</p>
                  {delivery.detail && <p className="delivery-detail">{delivery.detail}</p>}
                </li>
              ))}
            </ul>
          ) : <p className="message-meta">No recipients</p>}
        </>
      ) : detail.loading && <p className="empty-state" role="status">Loading message…</p>}
    </div>
  );
}
