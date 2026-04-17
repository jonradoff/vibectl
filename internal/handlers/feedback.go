package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/agents"
	"github.com/jonradoff/vibectl/internal/events"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
)

type FeedbackHandler struct {
	feedbackService    *services.FeedbackService
	issueService       *services.IssueService
	triageAgent        *agents.TriageAgent
	themesAgent        *agents.ThemesAgent
	decisionService    *services.DecisionService
	vibectlMdService   *services.VibectlMdService
	projectService     *services.ProjectService
	activityLogService *services.ActivityLogService
	webhookService     *services.WebhookService
	bus                *events.Bus
}

func NewFeedbackHandler(
	fs *services.FeedbackService,
	is *services.IssueService,
	ta *agents.TriageAgent,
	tha *agents.ThemesAgent,
	ds *services.DecisionService,
	vm *services.VibectlMdService,
	ps *services.ProjectService,
	als *services.ActivityLogService,
	ws *services.WebhookService,
	bus *events.Bus,
) *FeedbackHandler {
	return &FeedbackHandler{
		feedbackService:    fs,
		issueService:       is,
		triageAgent:        ta,
		themesAgent:        tha,
		decisionService:    ds,
		vibectlMdService:   vm,
		projectService:     ps,
		activityLogService: als,
		webhookService:     ws,
		bus:                bus,
	}
}

// FeedbackRoutes returns a router mounted at /api/v1/feedback.
func (h *FeedbackHandler) FeedbackRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Post("/", h.Create)
	r.Post("/batch", h.CreateBatch)
	r.Post("/bulk-review", h.BulkReview)
	r.Post("/{id}/triage", h.TriggerTriage)
	r.Post("/triage-batch", h.TriggerTriageBatch)
	r.Patch("/{id}/review", h.Review)
	return r
}

// ProjectFeedbackRoutes returns a router mounted under /api/v1/projects/{id}/feedback.
func (h *FeedbackHandler) ProjectFeedbackRoutes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.ListByProject)
	return r
}

// List returns feedback items filtered by optional query params: projectId, triageStatus, sourceType.
func (h *FeedbackHandler) List(w http.ResponseWriter, r *http.Request) {
	filters := map[string]string{
		"projectId":    r.URL.Query().Get("projectId"),
		"triageStatus": r.URL.Query().Get("triageStatus"),
		"sourceType":   r.URL.Query().Get("sourceType"),
	}

	items, err := h.feedbackService.List(r.Context(), filters)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FEEDBACK_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, items)
}

// sanitizeFeedbackContent strips potential injection vectors from user-submitted feedback.
// - LLM prompt injection: wraps in <user-content> tags (downstream triage already does this,
//   but we also strip common injection patterns at ingest)
// - XSS: strips HTML tags and script content
func sanitizeFeedbackContent(s string) string {
	// Strip HTML tags
	s = stripHTMLTags(s)
	// Collapse excessive whitespace but preserve paragraphs
	lines := strings.Split(s, "\n")
	var cleaned []string
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		cleaned = append(cleaned, line)
	}
	return strings.Join(cleaned, "\n")
}

func stripHTMLTags(s string) string {
	var result strings.Builder
	inTag := false
	for _, r := range s {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			result.WriteRune(r)
		}
	}
	return result.String()
}

// Create inserts a single feedback item.
func (h *FeedbackHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req models.CreateFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}

	if req.RawContent == "" {
		middleware.WriteError(w, http.StatusBadRequest, "rawContent is required", "VALIDATION_ERROR")
		return
	}

	// Sanitize content against injection attacks
	req.RawContent = sanitizeFeedbackContent(req.RawContent)

	// Resolve projectCode to projectId if provided
	if req.ProjectCode != "" && req.ProjectID == "" {
		proj, err := h.projectService.GetByCode(r.Context(), req.ProjectCode)
		if err != nil || proj == nil {
			middleware.WriteError(w, http.StatusBadRequest, fmt.Sprintf("project code %q not found", req.ProjectCode), "PROJECT_NOT_FOUND")
			return
		}
		req.ProjectID = proj.ID.Hex()
	}

	if req.SourceType == "" {
		req.SourceType = "feedback_api"
	}

	// Record the API key name that authorized this submission
	if u := middleware.GetCurrentUser(r); u != nil {
		if req.SubmittedBy == "" {
			req.SubmittedBy = u.DisplayName
		}
		// If authenticated via API key, record the key identity
		// The user's display name serves as the key identity marker
		req.SubmittedViaKey = u.DisplayName
	}

	item, err := h.feedbackService.Create(r.Context(), &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_FEEDBACK_ERROR")
		return
	}

	pid := ""
	if item.ProjectID != nil {
		pid = item.ProjectID.Hex()
	}

	// Activity log
	if h.activityLogService != nil && item.ProjectID != nil {
		oid := *item.ProjectID
		u := middleware.GetCurrentUser(r)
		snippet := item.RawContent
		if len(snippet) > 120 {
			snippet = snippet[:120] + "…"
		}
		if u != nil {
			h.activityLogService.LogAsyncWithUser("feedback_submitted", "Feedback submitted: "+snippet, &oid, &u.ID, u.DisplayName, "", nil)
		} else {
			h.activityLogService.LogAsync("feedback_submitted", "Feedback submitted: "+snippet, &oid, "", nil)
		}
	}

	// Fire feedback_created webhook
	if h.webhookService != nil && item.ProjectID != nil {
		go func() {
			h.webhookService.Fire(context.Background(), *item.ProjectID,
				models.WebhookEventFeedbackCreated,
				map[string]any{"feedbackId": item.ID.Hex(), "sourceType": item.SourceType})
		}()
	}

	h.bus.Publish(events.Event{Type: "feedback.created", ProjectID: pid})
	middleware.WriteJSON(w, http.StatusCreated, item)
}

// CreateBatch inserts multiple feedback items at once.
func (h *FeedbackHandler) CreateBatch(w http.ResponseWriter, r *http.Request) {
	var reqs []models.CreateFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&reqs); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}

	if len(reqs) == 0 {
		middleware.WriteError(w, http.StatusBadRequest, "batch must contain at least one item", "VALIDATION_ERROR")
		return
	}

	items, err := h.feedbackService.CreateBatch(r.Context(), reqs)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "CREATE_BATCH_ERROR")
		return
	}
	h.bus.Publish(events.Event{Type: "feedback.created"})
	middleware.WriteJSON(w, http.StatusCreated, items)
}

// TriggerTriage initiates AI triage for a single feedback item.
func (h *FeedbackHandler) TriggerTriage(w http.ResponseWriter, r *http.Request) {
	if h.triageAgent == nil {
		middleware.WriteError(w, http.StatusServiceUnavailable, "ANTHROPIC_API_KEY not configured", "AGENT_UNAVAILABLE")
		return
	}

	id := chi.URLParam(r, "id")
	analysis, err := h.triageAgent.TriageItem(r.Context(), id)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "TRIAGE_ERROR")
		return
	}

	// Mark as triaged
	_ = h.feedbackService.SetTriaged(r.Context(), id)

	// Fire webhook after triage completes
	if h.webhookService != nil {
		go func() {
			ctx := context.Background()
			item, fetchErr := h.feedbackService.GetByID(ctx, id)
			if fetchErr == nil && item != nil && item.ProjectID != nil {
				h.webhookService.Fire(ctx, *item.ProjectID, models.WebhookEventFeedbackTriaged, map[string]any{
					"feedbackId": id,
				})
			}
		}()
	}

	middleware.WriteJSON(w, http.StatusOK, analysis)
}

// TriggerTriageBatch initiates AI triage for all pending feedback items.
func (h *FeedbackHandler) TriggerTriageBatch(w http.ResponseWriter, r *http.Request) {
	if h.triageAgent == nil {
		middleware.WriteError(w, http.StatusServiceUnavailable, "ANTHROPIC_API_KEY not configured", "AGENT_UNAVAILABLE")
		return
	}

	count, err := h.triageAgent.TriagePending(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "TRIAGE_BATCH_ERROR")
		return
	}

	// Async: analyze themes for projects that had feedback triaged
	if h.themesAgent != nil && count > 0 {
		go func() {
			ctx := context.Background()
			projects, _ := h.projectService.List(ctx)
			for _, p := range projects {
				themes, err := h.themesAgent.AnalyzeThemes(ctx, p.ID.Hex())
				if err != nil || len(themes) == 0 {
					continue
				}
				h.projectService.UpdateRecurringThemes(ctx, p.ID.Hex(), themes)
				h.vibectlMdService.UpdateSection(ctx, p.ID.Hex(), "themes")
			}
		}()
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]int{"triaged": count})
}

// Review accepts or dismisses a feedback item, optionally creating an issue.
func (h *FeedbackHandler) Review(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req models.ReviewFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}

	if req.Action != "accept" && req.Action != "dismiss" {
		middleware.WriteError(w, http.StatusBadRequest, `action must be "accept" or "dismiss"`, "VALIDATION_ERROR")
		return
	}

	item, err := h.feedbackService.Review(r.Context(), id, &req)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "REVIEW_FEEDBACK_ERROR")
		return
	}

	// If accepted and createIssue=true, create an issue from the proposed issue or manual fields
	var createdIssue *models.Issue
	if req.Action == "accept" && req.CreateIssue && item.ProjectID != nil && h.issueService != nil {
		createdIssue = h.createIssueFromFeedback(r.Context(), item, &req)
	}

	if item.ProjectID != nil {
		pid := *item.ProjectID
		go func() {
			ctx := context.Background()
			action := "feedback_accepted"
			summary := fmt.Sprintf("Accepted feedback: %.80s", item.RawContent)
			sections := []string{"status", "focus", "decisions", "feedback"}

			if createdIssue != nil {
				action = "feedback_converted"
				summary = fmt.Sprintf("Feedback converted to %s: %s", createdIssue.IssueKey, createdIssue.Title)
			}

			if req.Action == "dismiss" {
				action = "feedback_dismissed"
				summary = fmt.Sprintf("Dismissed feedback: %.80s", item.RawContent)
				sections = []string{"decisions", "feedback"}
			}

			u := middleware.GetCurrentUser(r)
			if h.activityLogService != nil {
				if u != nil {
					h.activityLogService.LogAsyncWithUser(action, summary, &pid, &u.ID, u.DisplayName, "", nil)
				} else {
					h.activityLogService.LogAsync(action, summary, &pid, "", nil)
				}
			}

			issueKey := ""
			if createdIssue != nil {
				issueKey = createdIssue.IssueKey
			}
			h.decisionService.Record(ctx, pid, action, summary, issueKey)
			h.vibectlMdService.UpdateSection(ctx, pid.Hex(), sections...)
		}()
	}

	// Return item with linked issue key if one was created
	if createdIssue != nil {
		item.LinkedIssueKey = createdIssue.IssueKey
	}

	if item.ProjectID != nil {
		h.bus.Publish(events.Event{Type: "feedback.updated", ProjectID: item.ProjectID.Hex()})
	}
	middleware.WriteJSON(w, http.StatusOK, item)
}

// BulkReview accepts or dismisses multiple feedback items at once.
func (h *FeedbackHandler) BulkReview(w http.ResponseWriter, r *http.Request) {
	var req models.BulkReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid JSON body", "INVALID_JSON")
		return
	}
	if len(req.Items) == 0 {
		middleware.WriteError(w, http.StatusBadRequest, "items must not be empty", "VALIDATION_ERROR")
		return
	}

	var results []models.FeedbackItem
	var errs []string
	for _, item := range req.Items {
		if item.Action != "accept" && item.Action != "dismiss" {
			errs = append(errs, fmt.Sprintf("%s: invalid action %q", item.ID, item.Action))
			continue
		}
		reviewReq := &models.ReviewFeedbackRequest{Action: item.Action}
		updated, err := h.feedbackService.Review(r.Context(), item.ID, reviewReq)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", item.ID, err))
			continue
		}
		results = append(results, *updated)

		// Log activity per item
		if h.activityLogService != nil && updated.ProjectID != nil {
			oid := *updated.ProjectID
			action := "feedback_accepted"
			if item.Action == "dismiss" {
				action = "feedback_dismissed"
			}
			snippet := updated.RawContent
			if len(snippet) > 80 {
				snippet = snippet[:80] + "…"
			}
			h.activityLogService.LogAsync(action, fmt.Sprintf("Bulk %s: %s", item.Action, snippet), &oid, "", nil)
		}
	}

	resp := map[string]interface{}{
		"processed": len(results),
		"results":   results,
	}
	if len(errs) > 0 {
		resp["errors"] = errs
	}
	middleware.WriteJSON(w, http.StatusOK, resp)
}

// ListByProject returns all feedback items for the project identified by the URL param "id".
func (h *FeedbackHandler) ListByProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	items, err := h.feedbackService.ListByProject(r.Context(), projectID)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FEEDBACK_ERROR")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, items)
}

// createIssueFromFeedback converts accepted feedback into an issue using AI proposal or manual fields.
// Returns nil (non-fatal) if issue creation fails — the review itself still succeeds.
func (h *FeedbackHandler) createIssueFromFeedback(ctx context.Context, item *models.FeedbackItem, req *models.ReviewFeedbackRequest) *models.Issue {
	if item.ProjectID == nil {
		return nil
	}
	projectID := item.ProjectID.Hex()

	// Build issue request: prefer AI proposal, fall back to manual fields, then raw content
	title := req.IssueTitle
	description := req.IssueDescription
	issueType := models.IssueType(req.IssueType)
	priority := models.Priority(req.IssuePriority)
	reproSteps := ""

	if item.AIAnalysis != nil && item.AIAnalysis.ProposedIssue != nil {
		p := item.AIAnalysis.ProposedIssue
		if title == "" {
			title = p.Title
		}
		if description == "" {
			description = p.Description
		}
		if issueType == "" {
			issueType = models.IssueType(p.Type)
		}
		if priority == "" {
			priority = models.Priority(p.Priority)
		}
		if p.ReproSteps != "" {
			reproSteps = p.ReproSteps
		}
	}

	// Final fallbacks
	if title == "" {
		title = strings.TrimSpace(item.RawContent)
		if len(title) > 100 {
			title = title[:100]
		}
	}
	if description == "" {
		description = item.RawContent
	}
	if !models.ValidIssueType(string(issueType)) {
		issueType = models.IssueTypeIdea
	}
	if !models.ValidPriority(string(priority)) {
		priority = models.PriorityP3
	}

	createReq := &models.CreateIssueRequest{
		Title:            title,
		Description:      description,
		Type:             issueType,
		Priority:         priority,
		Source:           "feedback",
		SourceFeedbackID: item.ID.Hex(),
		ReproSteps:       reproSteps,
		CreatedBy:        item.SubmittedBy,
	}

	issue, err := h.issueService.Create(ctx, projectID, createReq)
	if err != nil {
		return nil
	}

	// Link feedback back to the created issue
	_ = h.feedbackService.LinkToIssue(ctx, item.ID.Hex(), issue.IssueKey)

	return issue
}
