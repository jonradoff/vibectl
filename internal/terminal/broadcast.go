package terminal

import (
	"sync"
)

// GlobalBroadcast allows sending messages to all connected WebSocket clients
// across both terminal and chat handlers.
type GlobalBroadcast struct {
	mu          sync.RWMutex
	subscribers map[chan string]struct{}
}

var globalBroadcast = &GlobalBroadcast{
	subscribers: make(map[chan string]struct{}),
}

// GetGlobalBroadcast returns the singleton global broadcast instance.
func GetGlobalBroadcast() *GlobalBroadcast {
	return globalBroadcast
}

// Subscribe returns a channel that receives global broadcast messages.
// The caller must call Unsubscribe when done.
func (b *GlobalBroadcast) Subscribe() chan string {
	ch := make(chan string, 4)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

// Unsubscribe removes a subscriber channel.
func (b *GlobalBroadcast) Unsubscribe(ch chan string) {
	b.mu.Lock()
	delete(b.subscribers, ch)
	b.mu.Unlock()
}

// Send broadcasts a message type to all subscribers.
func (b *GlobalBroadcast) Send(msgType string) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subscribers {
		select {
		case ch <- msgType:
		default:
			// skip slow subscribers
		}
	}
}
