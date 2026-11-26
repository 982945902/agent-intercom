import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { IntercomError, type Session } from '../../packages/sdk/index.js';
import { History } from './history.js';
import { errorMessage, sdk, useLiveEvents, useResource } from './live.js';

const selectionLimit = 100;
const loadRoster = () => sdk.listGroups();

type GroupAction = { name: string } | { groupId: string };

interface GroupSubmission {
  key: string;
  operationId: string;
  expectedMembershipVersions: Record<string, number>;
}

export function Dashboard() {
  const live = useLiveEvents();
  const roster = useResource(loadRoster, live.rosterRevision);
  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [destination, setDestination] = useState('');
  const [creating, setCreating] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [messageId, setMessageId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [groupError, setGroupError] = useState<string>();
  const [confirmation, setConfirmation] = useState<string>();
  const lastSubmission = useRef<GroupSubmission | null>(null);

  const groupNames = useMemo(() => new Map(roster.data?.map(group => [group.id, group.name])), [roster.data]);
  const sessions = useMemo(() => {
    const members = roster.data?.flatMap(group => group.members) ?? [];
    members.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return new Map(members.map(session => [session.id, session]));
  }, [roster.data]);
  const groupId = groupNames.has(filter) ? filter : undefined;
  const visible = [...sessions.values()].filter(session => groupId === undefined || session.groupId === groupId);
  const selectedIds = [...selection].filter(id => sessions.has(id));
  const selectedVisible = visible.filter(session => selection.has(session.id)).length;
  const allVisibleSelected = visible.length > 0 && selectedVisible === visible.length;
  const selectionFull = selectedIds.length === selectionLimit;
  const clearVisible = allVisibleSelected || (selectionFull && selectedVisible > 0);
  const online = [...sessions.values()].filter(session => session.online).length;

  useEffect(() => {
    if (!roster.data) return;
    setSelection(current => {
      const present = [...current].filter(id => sessions.has(id));
      return present.length === current.size ? current : new Set(present);
    });
  }, [roster.data, sessions]);

  function switchGroup(id: string) {
    if (id === filter) return;
    setFilter(id);
    setMessageId(null);
  }

  function toggleSession(id: string) {
    setSelection(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < selectionLimit) next.add(id);
      return next;
    });
  }

  function toggleVisible() {
    setSelection(current => {
      const next = new Set(current);
      for (const session of visible) {
        if (clearVisible) next.delete(session.id);
        else if (next.size < selectionLimit) next.add(session.id);
      }
      return next;
    });
  }

  async function changeGroup(action: GroupAction) {
    if (submitting) return;
    setSubmitting(true);
    setGroupError(undefined);
    setConfirmation(undefined);
    const sessionIds = selectedIds.toSorted();
    try {
      const key = JSON.stringify([action, sessionIds]);
      const submission = lastSubmission.current?.key === key ? lastSubmission.current : {
        key,
        operationId: crypto.randomUUID(),
        expectedMembershipVersions: Object.fromEntries(sessionIds.map(id => [id, sessions.get(id)!.membershipVersion])),
      };
      lastSubmission.current = submission;
      const { operationId, expectedMembershipVersions } = submission;
      const input = { sessionIds, operationId, expectedMembershipVersions };
      const result = 'name' in action ? await sdk.createGroup({ ...action, ...input }) : await sdk.moveGroup({ ...action, ...input });
      lastSubmission.current = null;
      setSelection(current => {
        const next = new Set(current);
        for (const id of sessionIds) next.delete(id);
        return next;
      });
      if ('name' in action) {
        setCreating(false);
        setGroupName('');
        setConfirmation(`Created ${result.group.name}${sessionIds.length ? ` with ${sessionIds.length} ${sessionIds.length === 1 ? 'session' : 'sessions'}` : ''}.`);
      } else {
        setDestination('');
        setConfirmation(`Moved ${sessionIds.length} ${sessionIds.length === 1 ? 'session' : 'sessions'} to ${result.group.name}.`);
      }
      roster.refresh();
    } catch (error) {
      if (error instanceof IntercomError && error.code !== 'HTTP_ERROR') lastSubmission.current = null;
      setGroupError(errorMessage(error));
      roster.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = groupName.trim();
    if (name) void changeGroup({ name });
  }

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <span className="brand-icon" aria-hidden="true"><i /><i /><i /></span>
            <h1>Agent Intercom</h1>
          </div>
          <div className="live-status">
            {roster.data && <span>{online} online</span>}
            <span className={live.streamError ? 'stream disconnected' : 'stream'}>
              {live.streamError ? 'Updates paused' : live.cursor === undefined ? 'Connecting' : 'Live updates'}
            </span>
            {live.cursor !== undefined && <span className="cursor">Cursor {live.cursor}</span>}
          </div>
        </div>
      </header>
      <main className="workspace">
        {live.streamError && (
          <div className="notice" role="alert">
            <span>{live.streamError}</span>
            <button type="button" className="button quiet" onClick={live.reconnect}>Reconnect</button>
          </div>
        )}
        {roster.error && (
          <div className="notice" role="alert">
            <span>{roster.error}</span>
            <button type="button" className="button quiet" onClick={roster.refresh}>Retry roster</button>
          </div>
        )}
        <nav className="group-bar" aria-label="Filter by group">
          <div className="group-filters">
            <button type="button" aria-pressed={groupId === undefined} onClick={() => switchGroup('')}>
              All groups <span>{sessions.size}</span>
            </button>
            {roster.data?.map(group => (
              <button type="button" key={group.id} aria-pressed={groupId === group.id} onClick={() => switchGroup(group.id)}>
                {group.name} <span>{group.members.length}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="panels">
          <section className="panel" aria-labelledby="roster-heading">
            <header className="panel-heading">
              <h2 id="roster-heading">Session roster</h2>
              <button type="button" className="button quiet" disabled={submitting} onClick={() => { setCreating(!creating); setGroupError(undefined); }}>
                {creating ? 'Cancel' : 'New group'}
              </button>
            </header>
            <div className="roster-actions">
              <div className="selection-summary">
                <span>{selectedIds.length} selected{selectedVisible < selectedIds.length ? ` · ${selectedIds.length - selectedVisible} outside filter` : ''}</span>
                {selectedIds.length > 0 && (
                  <button type="button" className="text-button" disabled={submitting} onClick={() => setSelection(new Set())}>Clear</button>
                )}
              </div>
              {creating ? (
                <form className="group-action" onSubmit={createGroup}>
                  <input aria-label="Group name" placeholder="Group name" maxLength={100} required value={groupName} disabled={submitting} onChange={event => setGroupName(event.target.value)} />
                  <button className="button primary" type="submit" disabled={submitting || !groupName.trim()}>
                    {selectedIds.length ? 'Create and move' : 'Create group'}
                  </button>
                </form>
              ) : (
                <form className="group-action" onSubmit={event => { event.preventDefault(); if (selectedIds.length && groupNames.has(destination)) void changeGroup({ groupId: destination }); }}>
                  <select aria-label="Destination group" value={groupNames.has(destination) ? destination : ''} disabled={submitting || !selectedIds.length} onChange={event => setDestination(event.target.value)}>
                    <option value="">Move to group…</option>
                    {roster.data?.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                  <button className="button primary" type="submit" disabled={submitting || !selectedIds.length || !groupNames.has(destination)}>Move</button>
                </form>
              )}
            </div>
            {submitting && <p className="feedback" role="status">Saving group membership…</p>}
            {groupError && <p className="feedback error" role="alert">{groupError}</p>}
            {confirmation && <p className="feedback success" role="status">{confirmation}</p>}
            {visible.length ? (
              <div className="roster-table">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">
                        <input type="checkbox" aria-label={clearVisible ? 'Deselect visible sessions' : `Select visible sessions, up to ${selectionLimit}`} checked={allVisibleSelected}
                          ref={node => { if (node) node.indeterminate = !allVisibleSelected && selectedVisible > 0; }}
                          disabled={submitting || (selectionFull && selectedVisible === 0)} onChange={toggleVisible} />
                      </th>
                      <th scope="col">Session</th>
                      <th scope="col">Group</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(session => (
                      <SessionRow key={session.id} session={session} groupName={groupNames.get(session.groupId)}
                        selected={selection.has(session.id)} disabled={submitting || (!selection.has(session.id) && selectionFull)}
                        onToggle={toggleSession} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : roster.data ? (
              <p className="empty-state">{groupId ? 'No sessions in this group.' : 'No sessions have joined yet.'}</p>
            ) : roster.loading && <p className="empty-state" role="status">Loading roster…</p>}
            {selectedIds.length === selectionLimit && <p className="feedback">Selection limit reached ({selectionLimit} sessions).</p>}
          </section>
          <History key={groupId ?? ''} groupId={groupId} groupNames={groupNames} sessions={sessions}
            revision={live.messageRevision} messageId={messageId} onOpen={setMessageId} />
        </div>
      </main>
    </>
  );
}

interface SessionRowProps {
  session: Session;
  groupName?: string;
  selected: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}

function SessionRow({ session, groupName, selected, disabled, onToggle }: SessionRowProps) {
  return (
    <tr data-selected={selected}>
      <td><input type="checkbox" aria-label={`Select ${session.name}`} checked={selected} disabled={disabled} onChange={() => onToggle(session.id)} /></td>
      <th scope="row">
        <span className="session-name" title={session.nativeSessionId}>{session.name}</span>
        <span className="session-meta">
          <span>{session.adapterKind}</span>
          {session.cwd && <span className="session-path" title={session.cwd}>{session.cwd}</span>}
        </span>
      </th>
      <td><span className="group-name" title={groupName ?? session.groupId}>{groupName ?? session.groupId}</span></td>
      <td><span className={`presence ${session.online ? 'online' : ''}`}>{session.online ? 'Online' : 'Offline'}</span></td>
    </tr>
  );
}
