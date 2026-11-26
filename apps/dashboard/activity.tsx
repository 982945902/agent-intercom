import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DeliveryState, IntercomEvent, Message, Session } from '../../packages/sdk/index.js';
import { deliveryLabels, kindLabels } from './message-labels.js';
import { cliNames, SessionIcon } from './session-icon.js';

const recentMessages = 3;

interface Route {
  id: string;
  to: string;
  state: DeliveryState;
}

export interface ActivityMessage {
  id: string;
  from: string;
  kind: Message['kind'];
  routes: Route[];
}

export function updateActivity(current: ActivityMessage[], events: IntercomEvent[], groupId: string, since: number) {
  let next = current;
  for (const event of events) {
    const { messageId, sessionId, state, deliveryId } = event;
    if (!messageId || !state) continue;
    if (event.type === 'message' && event.groupId === groupId && event.timestamp >= since && sessionId && Object.hasOwn(kindLabels, state)) {
      next = [{ id: messageId, from: sessionId, kind: state as Message['kind'], routes: [] },
        ...next.slice(0, recentMessages - 1)];
    } else if (event.type === 'delivery' && deliveryId && Object.hasOwn(deliveryLabels, state)) {
      const index = next.findIndex(message => message.id === messageId);
      if (index === -1) continue;
      const message = next[index];
      const routeIndex = message.routes.findIndex(route => route.id === deliveryId);
      if (routeIndex !== -1) {
        const routes = message.routes.with(routeIndex, { ...message.routes[routeIndex], state: state as DeliveryState });
        next = next.with(index, { ...message, routes });
      } else if (state === 'queued' && sessionId) {
        const routes: Route[] = [...message.routes, { id: deliveryId, to: sessionId, state }];
        next = next.with(index, { ...message, routes });
      }
    }
  }
  return next;
}

interface Point {
  x: number;
  y: number;
}

function layout(sessions: Session[], width: number) {
  const nodes = sessions.toSorted((a, b) => a.id.localeCompare(b.id));
  const count = nodes.length;
  const columns = Math.max(2, Math.min(7, Math.floor(width / 118)));
  const useOrbit = count <= (width < 480 ? 5 : 8);
  const rows = Math.ceil(count / columns);
  const height = useOrbit ? (count < 3 ? 224 : 304) : Math.max(304, rows * 98 + 22);
  const centerX = width / 2;
  const centerY = height / 2 - 9;
  const radiusX = Math.min(width / 2 - 62, 328);
  const radiusY = height / 2 - 52;
  const positions = new Map<string, Point>();
  nodes.forEach((session, index) => {
    if (count === 1) positions.set(session.id, { x: centerX, y: centerY });
    else if (useOrbit) {
      const angle = Math.PI * 2 * index / count - (count === 2 ? Math.PI : Math.PI / 2);
      positions.set(session.id, { x: centerX + radiusX * Math.cos(angle), y: centerY + radiusY * Math.sin(angle) });
    } else {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const rowSize = Math.min(columns, count - row * columns);
      positions.set(session.id, { x: centerX + (column - (rowSize - 1) / 2) * width / columns, y: centerY + (row - (rows - 1) / 2) * 98 });
    }
  });
  return { positions, height };
}

function geometry(from: Point, to: Point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 44) return undefined;
  const nx = dx / length;
  const ny = dy / length;
  return {
    transform: `translate(${from.x + nx * 19 - ny * 4} ${from.y + ny * 19 + nx * 4}) rotate(${Math.atan2(dy, dx) * 180 / Math.PI})`,
    distance: length - 38,
  };
}

interface ActivityProps {
  messages: ActivityMessage[];
  sessions: Session[];
  paused: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}

export function GroupActivity({ messages, sessions, paused, onToggle, onOpen }: ActivityProps) {
  const sky = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const element = sky.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(144, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { positions, height } = layout(sessions, width);
  const names = new Map(sessions.map(session => [session.id, session.name]));
  const edges = new Map<string, Route & { from: string; path: NonNullable<ReturnType<typeof geometry>> }>();
  const packets = messages.flatMap(message => message.routes.flatMap(route => {
    const from = positions.get(message.from);
    const to = positions.get(route.to);
    if (!from || !to) return [];
    const path = geometry(from, to);
    if (!path) return [];
    const edgeId = `${message.from}/${route.to}`;
    if (!edges.has(edgeId)) edges.set(edgeId, { ...route, from: message.from, path });
    return [{ id: route.id, path }];
  }));
  const latest = messages.find(message => message.routes.length);
  const receipts = new Map<DeliveryState, number>();
  for (const route of latest?.routes ?? []) receipts.set(route.state, (receipts.get(route.state) ?? 0) + 1);

  return (
    <section className="panel activity" aria-labelledby="activity-heading" data-paused={paused}>
      <header className="panel-heading">
        <h2 id="activity-heading">Session topology</h2>
        <button type="button" className="button quiet activity-motion-control" onClick={onToggle}>
          {paused ? 'Resume animation' : 'Pause animation'}
        </button>
      </header>
      <div className="activity-sky" ref={sky}>
        {sessions.length ? <svg className="activity-map" viewBox={`0 0 ${width} ${height}`}
          role="img" aria-label={`Message topology for ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`}>
          <defs>
            <radialGradient id="activity-halo">
              <stop offset="0" stopColor="#a994ff" stopOpacity=".36" />
              <stop offset="1" stopColor="#a994ff" stopOpacity="0" />
            </radialGradient>
          </defs>
          {[...edges].map(([id, edge]) => {
            const { transform, distance } = edge.path;
            return <g key={id} className="activity-edge" data-state={edge.state} transform={transform}>
              <title>{`${names.get(edge.from)} → ${names.get(edge.to)} · ${deliveryLabels[edge.state]}`}</title>
              <path d={`M 0 0 H ${distance} m -6 -3 l 6 3 -6 3`} />
            </g>;
          })}
          {packets.map(packet => <g key={packet.id} transform={packet.path.transform} aria-hidden="true" pointerEvents="none">
            <g className="activity-packet" style={{ '--flight': `${packet.path.distance}px` } as CSSProperties}>
              <path d="M -20 0 H 0" />
              <circle r="3" />
            </g>
          </g>)}
          {sessions.map(session => {
            const { x, y } = positions.get(session.id)!;
            const letters = Array.from(session.name);
            const name = letters.length > 17 ? `${letters.slice(0, 16).join('')}…` : session.name;
            return <g className="activity-star" key={session.id} data-online={session.online} transform={`translate(${x} ${y})`}>
              <title>{`${session.name} · ${cliNames[session.adapterKind]} · ${session.online ? 'Online' : 'Offline'}`}</title>
              {session.online && <circle className="activity-halo" r="35" fill="url(#activity-halo)" />}
              <circle className="activity-orbit" r="17" />
              <SessionIcon kind={session.adapterKind} offset={-9} />
              <text textAnchor="middle" y="31">{name}</text>
            </g>;
          })}
        </svg> : <p className="activity-empty">No sessions in this group.</p>}
      </div>
      {latest ? <div className="activity-caption">
        <button type="button" className="text-button" onClick={() => onOpen(latest.id)}>{kindLabels[latest.kind]}</button>
        <span className="activity-summary">{names.get(latest.from) ?? latest.from} → {latest.routes.length === 1
          ? (names.get(latest.routes[0].to) ?? latest.routes[0].to) : `${latest.routes.length} sessions`}</span>
        <span className="statuses">
          {[...receipts].map(([state, count]) => <span className={`badge ${state}`} key={state}>
            {latest.routes.length > 1 ? `${count} ` : ''}{deliveryLabels[state]}
          </span>)}
        </span>
      </div> : <p className="activity-caption">Waiting for new messages in this group.</p>}
    </section>
  );
}
