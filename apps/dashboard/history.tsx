import { useCallback, useState } from 'react';
import type { AskState, DeliveryState, Message, MessageRecord, Session } from '../../packages/sdk/index.js';
import { historyPageSize, loadHistory, sdk, useResource } from './live.js';

const deliveryLabels: Record<DeliveryState, string> = {
  queued: 'Queued',
  adapter_received: 'Adapter received',
  host_accepted: 'Host accepted',
  rejected: 'Rejected',
  delivery_unknown: 'Delivery unknown',
  expired: 'Expired',
};
const askLabels: Record<AskState, string> = {
  waiting: 'Waiting for reply',
  replied: 'Replied',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
};
const kindLabels: Record<Message['kind'], string> = {
  send: 'Direct',
  broadcast: 'Broadcast',
  ask: 'Ask',
  reply: 'Reply',
  late_reply: 'Late reply',
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

  return (
    <section className="panel" aria-labelledby="history-heading">
      <header className="panel-heading">
        <h2 id="history-heading">Message history</h2>
        {messageId && <button type="button" className="button quiet" onClick={() => onOpen(null)}>Back to history</button>}
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
                    <button className="message-row" type="button" onClick={() => onOpen(record.message.id)}>
                      <span className="message-row-heading">
                        <span className="message-sender">{record.message.fromName}</span>
                        <Timestamp value={record.message.createdAt} />
                      </span>
                      <span className="message-meta">
                        {kindLabels[record.message.kind]} · {groupNames.get(record.message.groupIdAtAccept) ?? record.message.groupIdAtAccept}
                      </span>
                      <span className="message-preview">{record.message.text}</span>
                      <MessageStatus record={record} />
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="empty-state">No messages in {groupId ? 'this group' : 'your history'} yet.</p>
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
