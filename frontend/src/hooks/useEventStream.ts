import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface ServerEvent {
  type: string;
  projectId?: string;
}

// Maps server event types to the React Query keys that should be invalidated.
function keysForEvent(e: ServerEvent): unknown[][] {
  const pid = e.projectId;
  switch (e.type) {
    case 'issue.created':
    case 'issue.updated':
    case 'issue.deleted':
      return [
        ['issues', pid],
        ['issues-archived', pid],
        ['globalDashboard'],
        ['project', pid],     // dashboard open-count badge
        ...(pid ? [['healthcheck', pid]] : []),
      ];
    case 'comment.created':
    case 'comment.deleted':
      return [['comments']]; // no pid needed — invalidate all comment queries
    case 'project.created':
    case 'project.updated':
    case 'project.deleted':
      return [
        ['projects'],
        ['archivedProjects'],
        ['globalDashboard'],
        ['universeData'],
        ...(pid ? [['project', pid]] : []),
      ];
    case 'feedback.created':
    case 'feedback.updated':
      return [
        ['feedback'],
        ['globalDashboard'],
        ...(pid ? [['projectFeedback', pid]] : []),
      ];
    case 'session.created':
    case 'session.updated':
      return [
        ...(pid ? [['project', pid]] : []),
        ['globalDashboard'],
      ];
    case 'prompt.created':
    case 'prompt.updated':
    case 'prompt.deleted':
      return [
        ['prompts'],
        ...(pid ? [['prompts', pid]] : []),
      ];
    case 'chat-history.created':
      return pid ? [['chatHistory', pid]] : [];
    default:
      return [];
  }
}

export function useEventStream() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource('/api/v1/events/stream');

    es.onmessage = (e) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event.type === 'connected') return;

      const keys = keysForEvent(event);
      for (const key of keys) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    };

    es.onerror = () => {
      // Browser auto-reconnects SSE; no action needed.
    };

    return () => es.close();
  }, [queryClient]);
}
