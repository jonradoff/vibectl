package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/client"
)

// LocalPathsHandler serves local path override CRUD in client mode.
// These endpoints are handled by the local client server and are NOT proxied
// to the remote.  They let the frontend read and write the per-project local
// path overrides stored on disk.
type LocalPathsHandler struct {
	store *client.PathStore
}

func NewLocalPathsHandler(store *client.PathStore) *LocalPathsHandler {
	return &LocalPathsHandler{store: store}
}

func (h *LocalPathsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.GetAll)
	r.Put("/{projectId}", h.Set)
	r.Delete("/{projectId}", h.Delete)
	return r
}

func (h *LocalPathsHandler) GetAll(w http.ResponseWriter, r *http.Request) {
	paths := h.store.GetAll()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(paths)
}

func (h *LocalPathsHandler) Set(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")
	var req struct {
		LocalPath string `json:"localPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.LocalPath == "" {
		http.Error(w, "localPath required", http.StatusBadRequest)
		return
	}
	if err := h.store.Set(projectID, req.LocalPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *LocalPathsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")
	if err := h.store.Delete(projectID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
