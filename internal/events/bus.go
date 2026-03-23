// Package events provides a lightweight in-process pub/sub event bus.
// Handlers publish events after successful writes; the SSE endpoint fans
// them out to connected browsers (and the client-mode relay goroutine).
package events

import (
	"sync"
)

// Event is a single mutation notification.
type Event struct {
	Type      string         `json:"type"`      // e.g. "issue.created"
	ProjectID string         `json:"projectId"` // empty for global events
	Payload   map[string]any `json:"payload,omitempty"`
}

// Bus is a thread-safe fanout pub/sub bus.
type Bus struct {
	mu          sync.RWMutex
	subscribers map[string]chan Event
}

func NewBus() *Bus {
	return &Bus{subscribers: make(map[string]chan Event)}
}

// Subscribe registers a listener and returns its ID, the channel to read from,
// and an unsubscribe function. The channel is buffered (64) so slow readers
// don't block publishers.
func (b *Bus) Subscribe(id string) (<-chan Event, func()) {
	ch := make(chan Event, 64)
	b.mu.Lock()
	b.subscribers[id] = ch
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subscribers, id)
		b.mu.Unlock()
		// drain so any in-flight Publish doesn't block
		for len(ch) > 0 {
			<-ch
		}
	}
}

// Publish sends an event to all current subscribers. Subscribers whose
// buffers are full are skipped (non-blocking).
func (b *Bus) Publish(e Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.subscribers {
		select {
		case ch <- e:
		default:
		}
	}
}
