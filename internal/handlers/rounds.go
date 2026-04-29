package handlers

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

// IntentSummary is a slim projection of an intent for the round context.
type IntentSummary struct {
	Title       string `json:"title"`
	Category    string `json:"category"`
	Status      string `json:"status"`
	Size        string `json:"size"`
	CompletedAt string `json:"completedAt"`
}

// RoundProjectContext is the per-project data returned by the round context endpoint.
type RoundProjectContext struct {
	ProjectCode          string             `json:"projectCode"`
	ProjectID            string             `json:"projectId"`
	ProjectName          string             `json:"projectName"`
	Goals                []string           `json:"goals,omitempty"`
	Tags                 []string           `json:"tags,omitempty"`
	Inactive             bool               `json:"inactive"`
	Paused               bool               `json:"paused"`
	SnoozedUntil         *time.Time         `json:"snoozedUntil,omitempty"`
	SnoozeReason         string             `json:"snoozeReason,omitempty"`
	OpenIssueCount       int                `json:"openIssueCount"`
	IssuesByPriority     map[string]int     `json:"issuesByPriority,omitempty"`
	PendingFeedbackCount int                `json:"pendingFeedbackCount"`
	AcceptedUnsubmitted  int                `json:"acceptedUnsubmitted"`
	CurrentHealth        string             `json:"currentHealth"`
	LastActivityAt       *string            `json:"lastActivityAt,omitempty"`
	LastPromptAt         *string            `json:"lastPromptAt,omitempty"`
	RecentIntents        []IntentSummary    `json:"recentIntents"`
	Note                 *models.ProjectNote `json:"note,omitempty"`
	LastSessionAt        *string            `json:"lastSessionAt,omitempty"`
	LastSessionMsgs      int                `json:"lastSessionMsgs,omitempty"`
	StatusNote           string             `json:"statusNote,omitempty"`
}

type RoundHandler struct {
	roundService        *services.RoundService
	noteService         *services.ProjectNoteService
	projectService      *services.ProjectService
	chatHistoryService  *services.ChatHistoryService
	intentService       *services.IntentService
	issueService        *services.IssueService
	feedbackService     *services.FeedbackService
	activityLogService  *services.ActivityLogService
	healthRecordService *services.HealthRecordService
}

func NewRoundHandler(
	rs *services.RoundService,
	ns *services.ProjectNoteService,
	ps *services.ProjectService,
	chs *services.ChatHistoryService,
	is *services.IntentService,
	iss *services.IssueService,
	fs *services.FeedbackService,
	als *services.ActivityLogService,
	hrs *services.HealthRecordService,
) *RoundHandler {
	return &RoundHandler{
		roundService:        rs,
		noteService:         ns,
		projectService:      ps,
		chatHistoryService:  chs,
		intentService:       is,
		issueService:        iss,
		feedbackService:     fs,
		activityLogService:  als,
		healthRecordService: hrs,
	}
}

func (h *RoundHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/context", h.Context)
	r.Post("/", h.Record)
	return r
}

// Context returns per-project data for a round step-through.
func (h *RoundHandler) Context(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	projects, err := h.projectService.List(ctx)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_PROJECTS_FAILED")
		return
	}

	// Bulk-fetch all project notes
	codes := make([]string, len(projects))
	for i, p := range projects {
		codes[i] = p.Code
	}
	noteMap, _ := h.noteService.GetByProjects(ctx, codes)

	results := make([]RoundProjectContext, len(projects))
	var wg sync.WaitGroup
	since := time.Now().UTC().AddDate(0, 0, -7)

	for i, project := range projects {
		wg.Add(1)
		go func(idx int, proj models.Project) {
			defer wg.Done()

			rpc := RoundProjectContext{
				ProjectCode:  proj.Code,
				ProjectID:    proj.ID.Hex(),
				ProjectName:  proj.Name,
				Goals:        proj.Goals,
				Tags:         proj.Tags,
				Inactive:     proj.Inactive,
				Paused:       proj.Paused,
				SnoozedUntil: proj.SnoozedUntil,
				SnoozeReason: proj.SnoozeReason,
			}

			// Issue counts
			issuesByStatus, _ := h.issueService.CountByProject(ctx, proj.Code)
			rpc.OpenIssueCount = issuesByStatus["open"]
			issuesByPriority, _ := h.issueService.CountByPriority(ctx, proj.Code)
			rpc.IssuesByPriority = issuesByPriority

			// Feedback
			rpc.PendingFeedbackCount, _ = h.feedbackService.CountPendingByProject(ctx, proj.Code)
			accepted, _ := h.feedbackService.ListAcceptedUnsubmitted(ctx, proj.Code)
			rpc.AcceptedUnsubmitted = len(accepted)

			// Health — derive overall status from individual check results
			rpc.CurrentHealth = "none"
			if h.healthRecordService != nil {
				if latest, err := h.healthRecordService.GetLatest(ctx, proj.Code); err == nil && latest != nil {
					priority := map[string]int{"up": 3, "degraded": 2, "down": 1, "unknown": 0}
					best := "unknown"
					for _, res := range latest.Results {
						if priority[res.Status] > priority[best] {
							best = res.Status
						}
					}
					rpc.CurrentHealth = best
				}
			}

			// Activity timestamps
			if t, err := h.activityLogService.LastActivityAt(ctx, proj.Code); err == nil && t != nil {
				s := t.Format(time.RFC3339)
				rpc.LastActivityAt = &s
			}
			if t, err := h.activityLogService.LastPromptAt(ctx, proj.Code); err == nil && t != nil {
				s := t.Format(time.RFC3339)
				rpc.LastPromptAt = &s
			}

			// Recent intents (last 7 days, max 3)
			intents, _ := h.intentService.ListByProject(ctx, proj.Code, since, 3)
			for _, intent := range intents {
				if intent.AnalysisModel == "skip" {
					continue
				}
				rpc.RecentIntents = append(rpc.RecentIntents, IntentSummary{
					Title:       intent.Title,
					Category:    intent.Category,
					Status:      intent.Status,
					Size:        intent.Size,
					CompletedAt: intent.CompletedAt.Format(time.RFC3339),
				})
			}
			if rpc.RecentIntents == nil {
				rpc.RecentIntents = []IntentSummary{}
			}

			// Note
			if note, ok := noteMap[proj.Code]; ok {
				rpc.Note = note
			}

			// Last chat session
			if h.chatHistoryService != nil {
				if sessions, err := h.chatHistoryService.ListByProject(ctx, proj.Code); err == nil && len(sessions) > 0 {
					s := sessions[0].EndedAt.Format(time.RFC3339)
					rpc.LastSessionAt = &s
					rpc.LastSessionMsgs = sessions[0].MessageCount
				}
			}

			// Status note
			rpc.StatusNote = proj.StatusNote

			results[idx] = rpc
		}(i, project)
	}
	wg.Wait()

	middleware.WriteJSON(w, http.StatusOK, results)
}

// Record persists a completed round summary.
func (h *RoundHandler) Record(w http.ResponseWriter, r *http.Request) {
	var summary models.RoundSummary
	if err := json.NewDecoder(r.Body).Decode(&summary); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON", "INVALID_JSON")
		return
	}
	if u := middleware.GetCurrentUser(r); u != nil {
		summary.UserID = &u.ID
	}
	if err := h.roundService.Record(r.Context(), &summary); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "RECORD_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusCreated, summary)
}
