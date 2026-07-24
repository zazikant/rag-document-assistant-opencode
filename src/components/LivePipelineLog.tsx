'use client';

import { useEffect, useRef } from 'react';

export interface LiveEvent {
  ts: number;
  type: string;
  line?: string;
  text?: string;
  stage?: string;
  ok?: boolean;
  elapsedMs?: number;
  summary?: string;
  message?: string;
}

function formatTime(ts: number): string {
  const t = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
}

function renderEvent(ev: LiveEvent, i: number) {
  const ts = formatTime(ev.ts);
  if (ev.type === 'stage-start') {
    return (
      <div key={i} style={{ color: '#7dd3fc' }}>
        <span style={{ color: '#52525b' }}>{ts}</span>{' '}
        <span style={{ color: '#38bdf8' }}>▶</span> stage-start{' '}
        <span style={{ color: '#bae6fd' }}>{ev.stage}</span>
      </div>
    );
  }
  if (ev.type === 'log' && ev.line) {
    const isErr = ev.line.includes('TIMEOUT') || ev.line.includes('ERROR') || ev.line.includes('failed');
    const isRetry = ev.line.includes('retry');
    const isDone = ev.line.includes('done');
    const isPipeline = ev.line.startsWith('[pipeline]');
    const color = isErr
      ? '#fda4af'
      : isRetry
        ? '#fcd34d'
        : isDone
          ? '#6ee7b7'
          : isPipeline
            ? '#c4b5fd'
            : '#d4d4d8';
    return (
      <div key={i} style={{ color }}>
        <span style={{ color: '#52525b' }}>{ts}</span> {ev.line}
      </div>
    );
  }
  if (ev.type === 'chunk') {
    return null; // hidden — live text panel shows chunks
  }
  if (ev.type === 'stage-end') {
    return (
      <div key={i} style={{ color: ev.ok ? '#6ee7b7' : '#fda4af' }}>
        <span style={{ color: '#52525b' }}>{ts}</span>{' '}
        <span style={{ color: ev.ok ? '#34d399' : '#f87171' }}>■</span>{' '}
        stage-end{' '}
        <span style={{ color: ev.ok ? '#a7f3d0' : '#fecaca' }}>{ev.stage}</span>{' '}
        {ev.elapsedMs}ms {ev.ok ? '✓' : '✗'} {ev.summary}
      </div>
    );
  }
  if (ev.type === 'error') {
    return (
      <div key={i} style={{ color: '#f87171', fontWeight: 'bold' }}>
        <span style={{ color: '#52525b' }}>{ts}</span>{' '}
        <span style={{ color: '#ef4444' }}>✗</span> ERROR: {ev.message}
      </div>
    );
  }
  return (
    <div key={i} style={{ color: '#a1a1aa' }}>
      <span style={{ color: '#52525b' }}>{ts}</span> {ev.type}
    </div>
  );
}

interface LivePipelineLogProps {
  events: LiveEvent[];
  visible: boolean;
  onClose: () => void;
}

export function LivePipelineLog({ events, visible, onClose }: LivePipelineLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events.length]);

  if (events.length === 0) return null;

  return (
    <div
      style={{
        borderRadius: '8px',
        background: '#09090b',
        color: '#f4f4f5',
        padding: '12px',
        maxHeight: '200px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        marginTop: '8px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '6px',
          borderBottom: '1px solid #27272a',
          paddingBottom: '4px',
          flexShrink: 0,
        }}
      >
        <span style={{ color: '#71717a', fontFamily: 'monospace', fontSize: '10px' }}>
          live pipeline log ({events.length} events)
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            color: '#71717a',
            fontSize: '10px',
            fontFamily: 'monospace',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {visible ? 'hide' : 'show'}
        </button>
      </div>
      {visible && (
        <div
          ref={containerRef}
          style={{
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: '11px',
            lineHeight: '1.6',
            flex: 1,
          }}
        >
          {events.map((ev, i) => renderEvent(ev, i))}
        </div>
      )}
    </div>
  );
}
