package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

// ClaudeUsageHandler exposes Claude Code token usage data via HTTP.
type ClaudeUsageHandler struct {
	usageService *services.ClaudeUsageService
}

// NewClaudeUsageHandler creates the handler.
func NewClaudeUsageHandler(us *services.ClaudeUsageService) *ClaudeUsageHandler {
	return &ClaudeUsageHandler{usageService: us}
}

// GetSummary returns usage summaries for all known Claude logins.
// GET /api/v1/claude-usage/summary
func (h *ClaudeUsageHandler) GetSummary(w http.ResponseWriter, r *http.Request) {
	summaries, err := h.usageService.GetAllSummaries(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "USAGE_SUMMARY_ERROR")
		return
	}
	if summaries == nil {
		summaries = []models.ClaudeUsageSummary{}
	}
	middleware.WriteJSON(w, http.StatusOK, summaries)
}

// UpdateConfig creates or updates the usage config for a login identity.
// PUT /api/v1/claude-usage/config
func (h *ClaudeUsageHandler) UpdateConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TokenHash        string `json:"tokenHash"`
		LoginLabel       string `json:"loginLabel"`
		WeeklyTokenLimit int64  `json:"weeklyTokenLimit"`
		AlertThreshold   int    `json:"alertThreshold"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "BAD_REQUEST")
		return
	}
	if req.TokenHash == "" {
		middleware.WriteError(w, http.StatusBadRequest, "tokenHash is required", "BAD_REQUEST")
		return
	}
	if req.AlertThreshold <= 0 {
		req.AlertThreshold = 70
	}

	cfg := &models.ClaudeUsageConfig{
		TokenHash:        req.TokenHash,
		LoginLabel:       req.LoginLabel,
		WeeklyTokenLimit: req.WeeklyTokenLimit,
		AlertThreshold:   req.AlertThreshold,
	}

	if err := h.usageService.UpsertConfig(r.Context(), cfg); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CONFIG_UPDATE_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, cfg)
}
