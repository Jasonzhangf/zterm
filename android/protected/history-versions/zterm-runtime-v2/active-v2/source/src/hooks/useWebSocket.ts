/**
 * useWebSocket - WebSocket 连接管理 hook
 * 支持自动重连、心跳保活、消息收发
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface WebSocketOptions {
  url: string;
  maxRetries?: number;        // 最大重连次数，默认 3
  retryInterval?: number;     // 重连间隔，默认 1000ms
  heartbeatInterval?: number; // 心跳间隔，默认 30000ms
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  onMessage?: (data: unknown) => void;
}

interface WebSocketState {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  retryCount: number;
}

export function useWebSocket(options: WebSocketOptions) {
  const {
    url,
    maxRetries = 3,
    retryInterval = 1000,
    heartbeatInterval = 30000,
    onOpen,
    onClose,
    onError,
    onMessage,
  } = options;

  const [state, setState] = useState<WebSocketState>({
    status: 'disconnected',
    retryCount: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = useRef(true);

  // 清理心跳定时器
  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  // 启动心跳
  const startHeartbeat = useCallback(() => {
    clearHeartbeat();
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, heartbeatInterval);
  }, [heartbeatInterval, clearHeartbeat]);

  // 连接 WebSocket
  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setState({ status: 'connecting', retryCount: state.retryCount });

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setState({ status: 'connected', retryCount: 0 });
        startHeartbeat();
        onOpen?.();
        console.log('[useWebSocket] Connected to', url);
      };

      ws.onclose = () => {
        clearHeartbeat();
        setState(prev => ({ ...prev, status: 'disconnected' }));
        onClose?.();
        console.log('[useWebSocket] Disconnected');

        // 自动重连
        if (
          shouldReconnectRef.current &&
          state.retryCount < maxRetries
        ) {
          console.log(`[useWebSocket] Reconnecting in ${retryInterval}ms (retry ${state.retryCount + 1}/${maxRetries})`);
          retryTimerRef.current = setTimeout(() => {
            setState(prev => ({ ...prev, retryCount: prev.retryCount + 1 }));
            connect();
          }, retryInterval);
        }
      };

      ws.onerror = (error) => {
        setState(prev => ({ ...prev, status: 'error' }));
        onError?.(error);
        console.error('[useWebSocket] Error:', error);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // 处理 pong 响应
          if (data.type === 'pong') {
            return;
          }

          onMessage?.(data);
        } catch (e) {
          // 非 JSON 数据，直接传递
          onMessage?.(event.data);
        }
      };
    } catch (error) {
      setState({ status: 'error', retryCount: state.retryCount });
      console.error('[useWebSocket] Connection error:', error);
    }
  }, [url, state.retryCount, maxRetries, retryInterval, startHeartbeat, clearHeartbeat, onOpen, onClose, onError, onMessage]);

  // 断开连接
  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    clearHeartbeat();
    
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setState({ status: 'disconnected', retryCount: 0 });
  }, [clearHeartbeat]);

  // 发送消息
  const send = useCallback((data: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      wsRef.current.send(message);
      return true;
    }
    console.warn('[useWebSocket] Cannot send: WebSocket not connected');
    return false;
  }, []);

  // 初始化连接
  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();

    return () => {
      disconnect();
    };
  }, [url]); // 只在 url 变化时重新连接

  // 手动重连
  const reconnect = useCallback(() => {
    setState({ status: 'disconnected', retryCount: 0 });
    shouldReconnectRef.current = true;
    connect();
  }, [connect]);

  return {
    status: state.status,
    retryCount: state.retryCount,
    send,
    connect,
    disconnect,
    reconnect,
    ws: wsRef.current,
  };
}
