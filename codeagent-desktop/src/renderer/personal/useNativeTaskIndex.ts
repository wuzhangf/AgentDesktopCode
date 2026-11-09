import {useCallback, useEffect, useRef, useState} from 'react';
import type {PersonalTaskIndex, PersonalTaskPage} from '../../../packages/protocol/src/personal-task';
import {personalCall} from './personalGateway';

/** Polled index of registered tasks on the personal management gateway.
 * Read-only projection: it never creates, adopts or re-dispatches tasks.
 * Disabled when no gateway is configured so ACS-only desktops pay no cost. */
export function useNativeTaskIndex(enabled: boolean): {
  items: PersonalTaskIndex[];
  error: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [items, setItems] = useState<PersonalTaskIndex[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);
  const activeRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const page = await personalCall<PersonalTaskPage>({action: 'TASKS', limit: '30'});
      if (activeRef.current) {
        // The shared task index also carries ACS-owned rows; the native rail
        // only lists source tasks. Older gateways without `core` still show —
        // they predate ACS rows in this index.
        setItems(Array.isArray(page.items) ? page.items.filter((item) => item.core !== 'ACS') : []);
        setError(null);
      }
    } catch (cause) {
      if (activeRef.current) setError((cause as Error).message);
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setError(null);
      return;
    }
    activeRef.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      activeRef.current = false;
      clearInterval(timer);
    };
  }, [enabled, refresh]);

  return {items, error, isLoading, refresh};
}
