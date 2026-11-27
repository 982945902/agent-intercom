import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { IntercomError, systemGroupId, type Session } from '../../packages/sdk/index.js';
import { GroupActivity } from './activity.js';
import { History } from './history.js';
import { errorMessage, sdk, useLiveEvents, useResource } from './live.js';
import { cliNames, SessionIcon } from './session-icon.js';

const selectionLimit = 100;
const loadRoster = () => sdk.listGroups();

const groupActionLabels = {
  create: { title: 'New group', submit: 'Create group' },
  add: { title: 'Add to group', submit: 'Add sessions' },
  remove: { title: 'Remove from group', submit: 'Remove sessions' },
};

type GroupMode = keyof typeof groupActionLabels;
type GroupAction = { mode: 'create'; name: string } | { mode: 'add' | 'remove'; groupId: string };

interface GroupSubmission {
  key: string;
  operationId: string;
  expectedMembershipVersions: Record<string, number>;
}

export function Dashboard() {
  const [filter, setFilter] = useState({ id: '', since: 0 });
  const [motionPaused, setMotionPaused] = useState(false);
  const live = useLiveEvents(filter);
  const roster = useResource(loadRoster, live.rosterRevision);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [destination, setDestination] = useState('');
  const [groupDialog, setGroupDialog] = useState<GroupMode | null>(null);
  const [groupName, setGroupName] = useState('');
  const [messageId, setMessageId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [groupError, setGroupError] = useState<string>();
  const [confirmation, setConfirmation] = useState<string>();
  const rosterHeading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const lastSubmission = useRef<GroupSubmission | null>(null);

  const groupNames = useMemo(() => new Map(roster.data?.map(group => [group.id, group.name])), [roster.data]);
  const sessions = useMemo(() => {
    const members = roster.data?.flatMap(group => group.members) ?? [];
    members.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return new Map(members.map(session => [session.id, session]));
  }, [roster.data]);
  const group = roster.data?.find(group => group.id === filter.id);
  const groupId = group?.id;
  const systemScope = group?.id === systemGroupId;
  const visible = systemScope
    ? group.members
    : [...sessions.values()].filter(session => groupId === undefined || session.groupIds.includes(groupId));
  const selectableVisible = systemScope ? [] : visible.filter(session => session.adapterKind !== 'service');
  const selectedIds = [...selection].filter(id => sessions.has(id));
  const selectedVisible = selectableVisible.filter(session => selection.has(session.id)).length;
  const allVisibleSelected = selectableVisible.length > 0 && selectedVisible === selectableVisible.length;
  const businessGroups = roster.data?.filter(group => group.id !== systemGroupId) ?? [];
  const destinationExists = businessGroups.some(group => group.id === destination);
  const selectionFull = selectedIds.length === selectionLimit;
  const clearVisible = allVisibleSelected || (selectionFull && selectedVisible > 0);
  const online = visible.filter(session => session.online).length;

  useEffect(() => {
    if (groupDialog && !dialog.current?.open) dialog.current?.showModal();
  }, [groupDialog]);

  useEffect(() => {
    if (!roster.data) return;
    setSelection(current => {
      const present = [...current].filter(id => sessions.has(id));
      return present.length === current.size ? current : new Set(present);
    });
  }, [roster.data, sessions]);

  function switchGroup(id: string) {
    if (id === filter.id) return;
    setFilter({ id, since: Date.now() });
    setMessageId(null);
  }

  function openGroupDialog(mode: GroupMode) {
    setGroupError(undefined);
    setGroupName('');
    setDestination(mode === 'remove' ? groupId ?? '' : '');
    setGroupDialog(mode);
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
      for (const session of selectableVisible) {
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
      const result = action.mode === 'create' ? await sdk.createGroup({ ...input, name: action.name })
        : action.mode === 'add' ? await sdk.addGroupMembers({ ...input, groupId: action.groupId })
        : await sdk.removeGroupMembers({ ...input, groupId: action.groupId });
      lastSubmission.current = null;
      setSelection(current => {
        const next = new Set(current);
        for (const id of sessionIds) next.delete(id);
        return next;
      });
      dialog.current?.close();
      if (action.mode === 'create') {
        setConfirmation(`Created ${result.group.name}${sessionIds.length ? ` with ${sessionIds.length} ${sessionIds.length === 1 ? 'session' : 'sessions'}` : ''}.`);
      } else {
        rosterHeading.current?.focus();
        setConfirmation(`Saved membership in ${result.group.name}.`);
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

  function submitGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (systemScope) return;
    if (groupDialog === 'create') {
      const name = groupName.trim();
      if (name) void changeGroup({ mode: 'create', name });
    } else if (groupDialog && selectedIds.length && destinationExists) {
      void changeGroup({ mode: groupDialog, groupId: destination });
    }
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Agent Intercom</span>
        </div>
        <nav className="group-nav" aria-label="Groups">
          <p className="nav-label">Groups</p>
          <div className="group-filters">
            <button type="button" aria-pressed={groupId === undefined} onClick={() => switchGroup('')}>
              <i className="group-icon all-icon" aria-hidden="true" />
              <span className="group-label">All groups</span><span className="group-count">{sessions.size}</span>
            </button>
            {roster.data?.map(group => (
              <button type="button" key={group.id} aria-pressed={groupId === group.id} onClick={() => switchGroup(group.id)}>
                <i className="group-icon" aria-hidden="true" />
                <span className="group-label">{group.name}</span><span className="group-count">{group.members.length}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-status" role="status">
          <span className="stream" data-state={live.streamError ? 'paused' : live.cursor === undefined ? 'connecting' : 'live'}>
            {live.streamError ? 'Updates paused' : live.cursor === undefined ? 'Connecting…' : 'Live updates'}
          </span>
        </div>
      </aside>
      <main className="workspace" id="workspace">
        <header className="workspace-heading">
          <div>
            <h1>{groupId ? groupNames.get(groupId) : 'All groups'}</h1>
            {roster.data && <p className="scope-summary">
              {visible.length} {visible.length === 1 ? 'session' : 'sessions'}
              <span className="scope-online">{online} online</span>
              {systemScope && <span>Read-only roster</span>}
            </p>}
          </div>
          {!systemScope && <button type="button" className="button primary" disabled={submitting || !roster.data} onClick={() => openGroupDialog('create')}>
            <span className="plus" aria-hidden="true">+</span> New group
          </button>}
        </header>
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
        {groupId && <GroupActivity messages={live.activity} sessions={visible} paused={motionPaused} onOpen={setMessageId}
          onToggle={() => setMotionPaused(paused => !paused)} />}
        <div className="panels">
          <section className="panel" aria-labelledby="roster-heading">
            <header className="panel-heading">
              <h2 id="roster-heading" ref={rosterHeading} tabIndex={-1}>Sessions</h2>
            </header>
            {!systemScope && selectedIds.length > 0 && (
              <div className="roster-actions">
                <div className="selection-summary" role="status">
                  <strong>{selectedIds.length} selected</strong>
                  {selectedVisible < selectedIds.length && <span>{selectedIds.length - selectedVisible} outside this group</span>}
                </div>
                <button type="button" className="text-button" disabled={submitting} onClick={() => setSelection(new Set())}>Clear</button>
                <button type="button" className="button quiet" disabled={submitting} onClick={() => openGroupDialog('add')}>{groupActionLabels.add.title}</button>
                <button type="button" className="button quiet" disabled={submitting} onClick={() => openGroupDialog('remove')}>{groupActionLabels.remove.title}</button>
              </div>
            )}
            {confirmation && <p className="feedback success" role="status">{confirmation}</p>}
            {visible.length ? (
              <div className="roster-table" role="region" aria-labelledby="roster-heading" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      {!systemScope && <th scope="col" className="selection-cell">
                        {selectableVisible.length > 0 && <label className="check-target">
                          <input type="checkbox" aria-label={clearVisible ? 'Deselect visible sessions' : `Select visible sessions, up to ${selectionLimit}`} checked={allVisibleSelected}
                            ref={node => { if (node) node.indeterminate = !allVisibleSelected && selectedVisible > 0; }}
                            disabled={submitting || (selectionFull && selectedVisible === 0)} onChange={toggleVisible} />
                        </label>}
                      </th>}
                      <th scope="col">Session</th>
                      <th scope="col" className="groups-column">Groups</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(session => (
                      <SessionRow key={session.id} session={session} groupNames={groupNames} showSelection={!systemScope}
                        selected={!systemScope && selection.has(session.id)} disabled={submitting || (!selection.has(session.id) && selectionFull)}
                        onToggle={toggleSession} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : roster.data ? (
              <div className="empty-state">
                <span className="empty-icon session-icon" aria-hidden="true" />
                <p>{groupId ? 'No sessions in this group' : 'No sessions have joined'}</p>
                {!systemScope && <p>{groupId ? 'Select sessions in another group and add them here.' : 'Join Intercom from a coding session to see it here.'}</p>}
              </div>
            ) : roster.loading && <p className="empty-state" role="status">Loading roster…</p>}
            {!systemScope && selectionFull && <p className="feedback">Selection limit reached ({selectionLimit} sessions).</p>}
          </section>
          <History key={groupId ?? ''} groupId={groupId} groupNames={groupNames} sessions={sessions}
            revision={live.messageRevision} messageId={messageId} onOpen={setMessageId} />
        </div>
      </main>
      <dialog ref={dialog} className="group-dialog" aria-labelledby="group-dialog-title"
        onClose={() => setGroupDialog(null)} onCancel={event => { if (submitting) event.preventDefault(); }}>
        {groupDialog && (
          <form method="post" aria-labelledby="group-dialog-title" onSubmit={submitGroup}>
            <h1 id="group-dialog-title">{groupActionLabels[groupDialog].title}</h1>
            {selectedIds.length > 0 && <p className="dialog-context">
              {selectedIds.length} selected {selectedIds.length === 1 ? 'session' : 'sessions'}
              {groupDialog === 'create' && ' will join this group and keep existing memberships.'}
            </p>}
            {groupDialog === 'remove' && <p className="dialog-context">Sessions with no other groups return to Default.</p>}
            {groupDialog === 'create' ? (
              <div className="field-label">
                <label htmlFor="group-name">Group name</label>
                <input id="group-name" name="name" autoFocus maxLength={100} required pattern=".*\S.*" title="Enter a group name"
                  value={groupName} readOnly={submitting} onChange={event => setGroupName(event.target.value)} />
              </div>
            ) : (
              <div className="field-label">
                <label htmlFor="group-destination">Group</label>
                <select id="group-destination" name="groupId" autoFocus required value={destinationExists ? destination : ''}
                  disabled={submitting} onChange={event => setDestination(event.target.value)}>
                  <option value="">Choose a group</option>
                  {businessGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </div>
            )}
            {groupError && <p className="feedback error" role="alert">{groupError}</p>}
            {submitting && <p className="dialog-context" role="status">Saving group membership…</p>}
            <div className="dialog-actions">
              <button type="button" className="button quiet" disabled={submitting} onClick={() => dialog.current?.close()}>Cancel</button>
              <button type="submit" className="button primary" disabled={submitting || (groupDialog !== 'create' && !selectedIds.length)}>
                {groupDialog === 'create' && selectedIds.length ? 'Create and add' : groupActionLabels[groupDialog].submit}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

interface SessionRowProps {
  session: Session;
  groupNames: ReadonlyMap<string, string>;
  showSelection: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}

function SessionRow({ session, groupNames, showSelection, selected, disabled, onToggle }: SessionRowProps) {
  return (
    <tr data-selected={selected}>
      {showSelection && <td className="selection-cell">
        {session.adapterKind !== 'service' && <label className="check-target"><input type="checkbox" aria-label={`Select ${session.name}`} checked={selected} disabled={disabled} onChange={() => onToggle(session.id)} /></label>}
      </td>}
      <th scope="row">
        <div className="session-cell">
          <span className="terminal-mark"><SessionIcon kind={session.adapterKind} /></span>
          <div className="session-identity">
            <span className="session-name" title={session.nativeSessionId}>{session.name}</span>
            <span className="session-meta">
              <span>{cliNames[session.adapterKind]}</span>
              {session.cwd && <span className="session-path" title={session.cwd}>{session.cwd}</span>}
            </span>
          </div>
        </div>
      </th>
      <td className="group-name">{session.groupIds.map(id => groupNames.get(id) ?? id).join(', ')}</td>
      <td><span className={`presence ${session.online ? 'online' : ''}`}>{session.online ? 'Online' : 'Offline'}</span></td>
    </tr>
  );
}
