package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.mongodb.org/mongo-driver/v2/bson"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type ProjectNoteHandler struct {
	noteService *services.ProjectNoteService
}

func NewProjectNoteHandler(ns *services.ProjectNoteService) *ProjectNoteHandler {
	return &ProjectNoteHandler{noteService: ns}
}

func (h *ProjectNoteHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Put("/{projectCode}", h.Upsert)
	r.Delete("/{projectCode}", h.Delete)
	return r
}

// Upsert creates or replaces the note for a project.
func (h *ProjectNoteHandler) Upsert(w http.ResponseWriter, r *http.Request) {
	projectCode := chi.URLParam(r, "projectCode")
	var req struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Text == "" {
		middleware.WriteError(w, http.StatusBadRequest, "text is required", "VALIDATION_ERROR")
		return
	}

	var userID *bson.ObjectID
	if u := middleware.GetCurrentUser(r); u != nil {
		userID = &u.ID
	}

	note, err := h.noteService.Upsert(r.Context(), projectCode, req.Text, userID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPSERT_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, note)
}

// Delete removes the note for a project.
func (h *ProjectNoteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	projectCode := chi.URLParam(r, "projectCode")
	if err := h.noteService.Delete(r.Context(), projectCode); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "DELETE_FAILED")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
