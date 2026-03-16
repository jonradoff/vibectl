package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type DashboardHandler struct {
	projectService  *services.ProjectService
	issueService    *services.IssueService
	sessionService  *services.SessionService
	feedbackService *services.FeedbackService
}

func NewDashboardHandler(
	ps *services.ProjectService,
	is *services.IssueService,
	ss *services.SessionService,
	fs *services.FeedbackService,
) *DashboardHandler {
	return &DashboardHandler{
		projectService:  ps,
		issueService:    is,
		sessionService:  ss,
		feedbackService: fs,
	}
}

// Routes returns a chi.Router with the global dashboard route.
func (h *DashboardHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.GlobalDashboard)
	return r
}

// GlobalDashboard returns a summary across all projects including open issue
// counts, priority breakdowns, and pending feedback count.
func (h *DashboardHandler) GlobalDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	projects, err := h.projectService.List(ctx)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_PROJECTS_FAILED")
		return
	}

	pendingFeedback, err := h.feedbackService.CountPending(ctx)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "COUNT_FEEDBACK_FAILED")
		return
	}

	totalOpenIssues := 0
	summaries := make([]models.ProjectSummary, 0, len(projects))

	for _, project := range projects {
		issuesByStatus, err := h.issueService.CountByProject(ctx, project.ID)
		if err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "COUNT_ISSUES_FAILED")
			return
		}

		issuesByPriority, err := h.issueService.CountByPriority(ctx, project.ID)
		if err != nil {
			middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "COUNT_ISSUES_FAILED")
			return
		}

		openCount := issuesByStatus["open"]
		totalOpenIssues += openCount

		var lastSession *models.SessionLog
		session, err := h.sessionService.GetLatest(ctx, project.ID.Hex())
		if err == nil {
			lastSession = session
		}

		summaries = append(summaries, models.ProjectSummary{
			Project:          project,
			OpenIssueCount:   openCount,
			IssuesByPriority: issuesByPriority,
			IssuesByStatus:   issuesByStatus,
			LastSession:      lastSession,
		})
	}

	dashboard := models.GlobalDashboard{
		TotalProjects:    len(projects),
		TotalOpenIssues:  totalOpenIssues,
		PendingFeedback:  pendingFeedback,
		ProjectSummaries: summaries,
	}

	middleware.WriteJSON(w, http.StatusOK, dashboard)
}
