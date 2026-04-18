package handlers

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/agents"
	"github.com/jonradoff/vibectl/internal/ingestion"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
)

type AgentHandler struct {
	pmAgent          *agents.PMReviewAgent
	archAgent        *agents.ArchitectureAgent
	sweeper          *ingestion.GitHubSweeper
	projectService   *services.ProjectService
	vibectlMdService *services.VibectlMdService
	decisionService  *services.DecisionService
}

func NewAgentHandler(pmAgent *agents.PMReviewAgent, archAgent *agents.ArchitectureAgent, sweeper *ingestion.GitHubSweeper, ps *services.ProjectService, vm *services.VibectlMdService, ds *services.DecisionService) *AgentHandler {
	return &AgentHandler{pmAgent: pmAgent, archAgent: archAgent, sweeper: sweeper, projectService: ps, vibectlMdService: vm, decisionService: ds}
}

func (h *AgentHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Post("/pm-review/{projectId}", h.TriggerPMReview)
	r.Post("/github-sweep", h.TriggerGitHubSweep)
	return r
}

func (h *AgentHandler) TriggerPMReview(w http.ResponseWriter, r *http.Request) {
	if h.pmAgent == nil {
		middleware.WriteError(w, http.StatusServiceUnavailable, "ANTHROPIC_API_KEY not configured", "AGENT_UNAVAILABLE")
		return
	}

	projectID := chi.URLParam(r, "projectId")
	result, err := h.pmAgent.Review(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "PM_REVIEW_ERROR")
		return
	}

	// Async: record decision, generate architecture summary, regenerate VIBECTL.md
	go func() {
		ctx := context.Background()
		project, _ := h.projectService.GetByID(ctx, projectID)
		if project != nil {
			h.decisionService.Record(ctx, project.Code, "pm_review",
				"PM review completed: "+result.OverallAssessment, "")

			if h.archAgent != nil {
				summary, err := h.archAgent.Summarize(ctx, projectID)
				if err != nil {
					slog.Error("architecture summary failed", "error", err)
				} else {
					h.projectService.UpdateArchitectureSummary(ctx, projectID, summary)
				}
			}

			h.vibectlMdService.WriteToProject(ctx, projectID)
		}
	}()

	middleware.WriteJSON(w, http.StatusOK, result)
}

func (h *AgentHandler) TriggerGitHubSweep(w http.ResponseWriter, r *http.Request) {
	if h.sweeper == nil {
		middleware.WriteError(w, http.StatusServiceUnavailable, "GITHUB_TOKEN not configured", "SWEEPER_UNAVAILABLE")
		return
	}

	count, err := h.sweeper.Sweep(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GITHUB_SWEEP_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]int{"imported": count})
}
