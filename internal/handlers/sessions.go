package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/events"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type SessionHandler struct {
	sessionService *services.SessionService
	bus            *events.Bus
}

func NewSessionHandler(ss *services.SessionService, bus *events.Bus) *SessionHandler {
	return &SessionHandler{sessionService: ss, bus: bus}
}

// ProjectSessionRoutes returns a router mounted under /api/v1/projects/{id}/sessions.
func (h *SessionHandler) ProjectSessionRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListByProject)
	r.Get("/latest", h.GetLatest)
	r.Post("/", h.Create)
	return r
}

// SessionRoutes returns a router mounted at /api/v1/sessions.
func (h *SessionHandler) SessionRoutes() chi.Router {
	r := chi.NewRouter()
	r.Patch("/{id}", h.Update)
	return r
}

// ListByProject returns all sessions for the project identified by the URL param "id".
func (h *SessionHandler) ListByProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	sessions, err := h.sessionService.ListByProject(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_SESSIONS_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, sessions)
}

// GetLatest returns the most recent session for the project identified by the URL param "id".
func (h *SessionHandler) GetLatest(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	session, err := h.sessionService.GetLatest(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GET_LATEST_SESSION_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, session)
}

// Create starts a new session for the project identified by the URL param "id".
func (h *SessionHandler) Create(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	session, err := h.sessionService.Create(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_SESSION_ERROR")
		return
	}
	h.bus.Publish(events.Event{Type: "session.created", ProjectCode: projectID})
	middleware.WriteJSON(w, http.StatusCreated, session)
}

// Update applies partial updates to a session identified by the URL param "id".
func (h *SessionHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req models.UpdateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}

	session, err := h.sessionService.Update(r.Context(), id, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_SESSION_ERROR")
		return
	}
	h.bus.Publish(events.Event{Type: "session.updated", ProjectCode: session.ProjectCode})
	middleware.WriteJSON(w, http.StatusOK, session)
}
