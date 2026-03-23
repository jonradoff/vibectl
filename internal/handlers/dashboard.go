package handlers

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type DashboardHandler struct {
	projectService      *services.ProjectService
	issueService        *services.IssueService
	sessionService      *services.SessionService
	feedbackService     *services.FeedbackService
	memberService       *services.ProjectMemberService
	activityLogService  *services.ActivityLogService
	healthRecordService *services.HealthRecordService
}

func NewDashboardHandler(
	ps *services.ProjectService,
	is *services.IssueService,
	ss *services.SessionService,
	fs *services.FeedbackService,
	ms *services.ProjectMemberService,
	als *services.ActivityLogService,
	hrs *services.HealthRecordService,
) *DashboardHandler {
	return &DashboardHandler{
		projectService:      ps,
		issueService:        is,
		sessionService:      ss,
		feedbackService:     fs,
		memberService:       ms,
		activityLogService:  als,
		healthRecordService: hrs,
	}
}

// Routes returns a chi.Router with the global dashboard route.
func (h *DashboardHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.GlobalDashboard)
	r.Get("/universe", h.Universe)
	return r
}

// GlobalDashboard returns a summary across all projects including open issue
// counts, priority breakdowns, and pending feedback count.
func (h *DashboardHandler) GlobalDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	currentUser := middleware.GetCurrentUser(r)

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

		// Determine current user's effective role for this project.
		currentUserRole := ""
		if currentUser != nil {
			if currentUser.GlobalRole == models.GlobalRoleSuperAdmin {
				currentUserRole = string(models.ProjectRoleOwner)
			} else if h.memberService != nil {
				role, _ := h.memberService.GetRole(ctx, project.ID, currentUser.ID)
				currentUserRole = string(role)
			}
		}

		summaries = append(summaries, models.ProjectSummary{
			Project:          project,
			OpenIssueCount:   openCount,
			IssuesByPriority: issuesByPriority,
			IssuesByStatus:   issuesByStatus,
			LastSession:      lastSession,
			CurrentUserRole:  currentUserRole,
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

// Universe returns per-project time-series data for the Universe panel visualization.
// GET /api/v1/dashboard/universe
func (h *DashboardHandler) Universe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	projects, err := h.projectService.List(ctx)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_PROJECTS_FAILED")
		return
	}

	results := make([]models.ProjectUniverseData, len(projects))
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error

	for i, project := range projects {
		proj := project
		pidx := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			data := models.ProjectUniverseData{
				ProjectID:   proj.ID.Hex(),
				ProjectName: proj.Name,
				ProjectCode: proj.Code,
			}

			// Activity sparkline: 90 days
			actByDay, err := h.activityLogService.DailyActivityCounts(ctx, proj.ID, 90)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("activity counts for %s: %w", proj.Code, err)
				}
				mu.Unlock()
				return
			}
			data.ActivityByDay = actByDay

			// Health sparkline: 7 days
			healthByDay, err := h.healthRecordService.DailyHealthStatus(ctx, proj.ID, 7)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("health status for %s: %w", proj.Code, err)
				}
				mu.Unlock()
				return
			}
			data.HealthByDay = healthByDay

			// Current health: latest record
			latestHealth, _ := h.healthRecordService.GetLatest(ctx, proj.ID)
			if latestHealth == nil || len(latestHealth.Results) == 0 {
				data.CurrentHealth = "none"
			} else {
				priority := map[string]int{"up": 3, "degraded": 2, "down": 1, "unknown": 0}
				best := "unknown"
				for _, res := range latestHealth.Results {
					if priority[res.Status] > priority[best] {
						best = res.Status
					}
				}
				data.CurrentHealth = best
			}

			// Issue counts
			issuesByStatus, _ := h.issueService.CountByProject(ctx, proj.ID)
			data.IssuesByStatus = issuesByStatus
			data.OpenIssueCount = issuesByStatus["open"]

			// Pending feedback count
			pendingFeedback, _ := h.feedbackService.CountPendingByProject(ctx, proj.ID)
			data.PendingFeedbackCount = pendingFeedback

			// Deploy count: last 30 days
			deploys, _ := h.activityLogService.DeployCountSince(ctx, proj.ID, 30)
			data.DeployCount = deploys

			// Last activity timestamp
			lastAt, _ := h.activityLogService.LastActivityAt(ctx, proj.ID)
			if lastAt != nil {
				s := lastAt.UTC().Format(time.RFC3339)
				data.LastActivityAt = &s
			}

			mu.Lock()
			results[pidx] = data
			mu.Unlock()
		}()
	}
	wg.Wait()

	if firstErr != nil {
		middleware.WriteError(w, http.StatusInternalServerError, firstErr.Error(), "UNIVERSE_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, results)
}
