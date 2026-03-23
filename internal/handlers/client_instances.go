package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// ClientInstanceHandler exposes CRUD endpoints for client instances.
// These live on the remote (standalone) server and allow developers to
// register their local client instances and store per-project path overrides.
type ClientInstanceHandler struct {
	svc *services.ClientInstanceService
}

func NewClientInstanceHandler(svc *services.ClientInstanceService) *ClientInstanceHandler {
	return &ClientInstanceHandler{svc: svc}
}

func (h *ClientInstanceHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Post("/", h.Create)
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", h.GetByID)
		r.Put("/", h.Update)
		r.Delete("/", h.Delete)
	})
	return r
}

func (h *ClientInstanceHandler) List(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	instances, err := h.svc.ListByUser(r.Context(), user.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if instances == nil {
		instances = []*models.ClientInstance{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(instances)
}

func (h *ClientInstanceHandler) Create(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req models.CreateClientInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	inst, err := h.svc.Create(r.Context(), user.ID, req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(inst)
}

func (h *ClientInstanceHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	inst, err := h.svc.GetByID(r.Context(), id)
	if err != nil || inst.UserID != user.ID {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(inst)
}

func (h *ClientInstanceHandler) Update(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	existing, err := h.svc.GetByID(r.Context(), id)
	if err != nil || existing.UserID != user.ID {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var req models.UpdateClientInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	inst, err := h.svc.Update(r.Context(), id, req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(inst)
}

func (h *ClientInstanceHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetCurrentUser(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id, err := bson.ObjectIDFromHex(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	existing, err := h.svc.GetByID(r.Context(), id)
	if err != nil || existing.UserID != user.ID {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err := h.svc.Delete(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
