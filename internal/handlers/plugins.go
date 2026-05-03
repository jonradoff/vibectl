package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type PluginHandler struct {
	pluginService *services.PluginService
}

func NewPluginHandler(ps *services.PluginService) *PluginHandler {
	return &PluginHandler{pluginService: ps}
}

func (h *PluginHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListInstalled)
	r.Get("/commands", h.ListCommands)
	r.Get("/available", h.ListAvailable)
	r.Get("/marketplaces", h.ListMarketplaces)
	r.Post("/marketplaces", h.AddMarketplace)
	r.Post("/install", h.Install)
	r.Post("/{id}/enable", h.Enable)
	r.Post("/{id}/disable", h.Disable)
	r.Delete("/{id}", h.Uninstall)
	return r
}

func (h *PluginHandler) ListInstalled(w http.ResponseWriter, r *http.Request) {
	plugins, err := h.pluginService.ListInstalled()
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, plugins)
}

func (h *PluginHandler) ListCommands(w http.ResponseWriter, r *http.Request) {
	cmds := h.pluginService.ListCommands()
	if cmds == nil {
		cmds = []services.PluginCommand{}
	}
	middleware.WriteJSON(w, http.StatusOK, cmds)
}

func (h *PluginHandler) ListAvailable(w http.ResponseWriter, r *http.Request) {
	plugins, err := h.pluginService.ListAvailable()
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, plugins)
}

func (h *PluginHandler) ListMarketplaces(w http.ResponseWriter, r *http.Request) {
	marketplaces, err := h.pluginService.ListMarketplaces()
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, marketplaces)
}

func (h *PluginHandler) AddMarketplace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Repo string `json:"repo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" || req.Repo == "" {
		middleware.WriteError(w, http.StatusBadRequest, "id and repo are required", "VALIDATION_ERROR")
		return
	}
	if err := h.pluginService.AddMarketplace(req.ID, req.Repo); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "ADD_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "added"})
}

func (h *PluginHandler) Enable(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.pluginService.SetEnabled(id, true); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "ENABLE_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "enabled"})
}

func (h *PluginHandler) Disable(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.pluginService.SetEnabled(id, false); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "DISABLE_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "disabled"})
}

func (h *PluginHandler) Install(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Marketplace string `json:"marketplace"`
		Name        string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Marketplace == "" || req.Name == "" {
		middleware.WriteError(w, http.StatusBadRequest, "marketplace and name are required", "VALIDATION_ERROR")
		return
	}
	if err := h.pluginService.InstallPlugin(req.Marketplace, req.Name); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "INSTALL_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "installed"})
}

func (h *PluginHandler) Uninstall(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.pluginService.UninstallPlugin(id); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UNINSTALL_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "uninstalled"})
}
