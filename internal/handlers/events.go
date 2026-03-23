package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jonradoff/vibectl/internal/events"
)

type EventsHandler struct {
	bus *events.Bus
}

func NewEventsHandler(bus *events.Bus) *EventsHandler {
	return &EventsHandler{bus: bus}
}

// Stream serves GET /api/v1/events/stream as an SSE endpoint.
// Any authenticated client (browser or client-mode relay) can connect.
func (h *EventsHandler) Stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	id := uuid.New().String()
	ch, unsub := h.bus.Subscribe(id)
	defer unsub()

	// Send an initial connected event so the client knows the stream is live.
	fmt.Fprintf(w, "data: {\"type\":\"connected\"}\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		case e := <-ch:
			data, err := json.Marshal(e)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}
