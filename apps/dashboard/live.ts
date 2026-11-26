import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createHttpSdk, type EventsPage, type Input, type Results } from '../../packages/sdk/index.js';
import { updateActivity, type ActivityMessage } from './activity.js';

export const sdk = createHttpSdk();

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useResource<T>(load: () => Promise<T>, revision: number) {
  const [resource, setResource] = useState<Resource<T>>({ data: null, error: null, loading: true });
  const request = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let running = false;
    let pending = false;

    async function fetchLatest() {
      running = true;
      do {
        pending = false;
        setResource(current => ({ ...current, loading: true }));
        try {
          const data = await load();
          if (!disposed) setResource({ data, error: null, loading: false });
        } catch (error) {
          if (!disposed) setResource(current => ({ ...current, error: errorMessage(error), loading: false }));
        }
      } while (pending && !disposed);
      running = false;
    }

    request.current = () => {
      if (running) pending = true;
      else void fetchLatest();
    };
    return () => { disposed = true; };
  }, [load]);

  const refresh = useCallback(() => request.current(), []);
  useEffect(refresh, [load, refresh, revision]);

  return { ...resource, refresh };
}

export function useLiveEvents(group: { id: string; since: number }) {
  const [activity, setActivity] = useState<{ group: typeof group; messages: ActivityMessage[] }>();
  const [cursor, setCursor] = useState<number>();
  const [rosterRevision, setRosterRevision] = useState(0);
  const [messageRevision, setMessageRevision] = useState(0);
  const [streamError, setStreamError] = useState<string>();
  const [subscription, setSubscription] = useState(0);
  const lastCursor = useRef<number | undefined>(undefined);
  const showActivity = useEffectEvent((page: EventsPage, connectedAt: number) => {
    if (!group.id) return;
    setActivity(current => {
      const previous = current?.group === group && !page.reset ? current.messages : [];
      const messages = updateActivity(previous, page.events, group.id, Math.max(group.since, connectedAt));
      return current?.group === group && current.messages === messages ? current : { group, messages };
    });
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function subscribe() {
      const connectedAt = Date.now();
      try {
        for await (const page of sdk.events(lastCursor.current, signal)) {
          if (signal.aborted) break;
          lastCursor.current = page.cursor;
          setCursor(page.cursor);
          setStreamError(undefined);
          if (page.reset || page.events.some(event => event.type === 'session' || event.type === 'group')) {
            setRosterRevision(revision => revision + 1);
          }
          if (page.reset || page.events.some(event => event.type === 'message' || event.type === 'delivery' || event.type === 'ask')) {
            setMessageRevision(revision => revision + 1);
            showActivity(page, connectedAt);
          }
        }
      } catch (error) {
        if (!signal.aborted) setStreamError(errorMessage(error));
      }
    }
    void subscribe();
    return () => controller.abort();
  }, [subscription]);

  return {
    cursor, rosterRevision, messageRevision, streamError,
    activity: activity?.group === group ? activity.messages : [],
    reconnect() {
      setStreamError(undefined);
      setSubscription(attempt => attempt + 1);
    },
  };
}

export const historyPageSize = 50;

export async function loadHistory(groupId: string | undefined, count: number): Promise<Results['listMessages']> {
  const records: Results['listMessages']['records'] = [];
  let nextBefore: number | null = null;
  do {
    const input: Input<'listMessages'> = { groupId, limit: Math.min(200, count - records.length) };
    if (nextBefore !== null) input.before = nextBefore;
    const page = await sdk.listMessages(input);
    records.push(...page.records);
    nextBefore = page.nextBefore;
  } while (nextBefore !== null && records.length < count);
  return { records, nextBefore };
}
