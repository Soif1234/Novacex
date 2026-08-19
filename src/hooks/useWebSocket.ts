/**
 * React WebSocket Hooks
 * Provides declarative channel subscription and live event dispatch.
 */

import { useState, useEffect, useRef } from 'react';
import { wsClient } from '../services/websocket/wsClient';

export function useWebSocketChannel<T = any>(
  channel: string | null,
  onData?: (data: T, type: 'event' | 'snapshot') => void
) {
  const [data, setData] = useState<T | null>(null);
  const callbackRef = useRef(onData);
  callbackRef.current = onData;

  useEffect(() => {
    if (!channel) return;

    const unsubscribe = wsClient.subscribe(channel, (incomingData: T, type) => {
      setData(incomingData);
      if (callbackRef.current) {
        callbackRef.current(incomingData, type);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [channel]);

  return { data };
}

export function usePrivateStream<T = any>(
  channel: string | null,
  onEvent: (payload: T) => void
) {
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  useEffect(() => {
    if (!channel) return;

    const unsubscribe = wsClient.subscribe(channel, (incomingData: T) => {
      if (callbackRef.current) {
        callbackRef.current(incomingData);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [channel]);
}

export function useWebSocketStatus() {
  const [status, setStatus] = useState<'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING'>(
    wsClient.isConnected() ? 'CONNECTED' : 'DISCONNECTED'
  );

  useEffect(() => {
    const unsub = wsClient.onStatusChange((s) => {
      setStatus(s);
    });
    return () => {
      unsub();
    };
  }, []);

  return { status, isConnected: status === 'CONNECTED' };
}
