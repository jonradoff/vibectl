package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type IntentHandler struct {
	intentService    *services.IntentService
	intentExtractor  *services.IntentExtractor
	projectService   *services.ProjectService
}

func NewIntentHandler(is *services.IntentService, ie *services.IntentExtractor, ps *services.ProjectService) *IntentHandler {
	return &IntentHandler{intentService: is, intentExtractor: ie, projectService: ps}
}

func (h *IntentHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	r.Get("/productivity", h.Productivity)
	r.Get("/insights", h.Insights)
	r.Post("/backfill", h.Backfill)
	r.Get("/backfill-count", h.BackfillCount)
	r.Get("/{id}", h.GetByID)
	r.Patch("/{id}", h.PatchIntent)
	r.Post("/{id}/link-pr", h.LinkPR)
	return r
}

func (h *IntentHandler) List(w http.ResponseWriter, r *http.Request) {
	projectID := r.URL.Query().Get("projectId")
	status := r.URL.Query().Get("status")
	category := r.URL.Query().Get("category")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	sinceStr := r.URL.Query().Get("since")
	var since time.Time
	if sinceStr != "" {
		since, _ = time.Parse(time.RFC3339, sinceStr)
	}
	if daysStr := r.URL.Query().Get("days"); daysStr != "" && since.IsZero() {
		days, _ := strconv.Atoi(daysStr)
		if days > 0 {
			since = time.Now().UTC().AddDate(0, 0, -days)
		}
	}

	intents, err := h.intentService.List(r.Context(), projectID, status, category, since, limit)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "LIST_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, intents)
}

func (h *IntentHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid id", "BAD_REQUEST")
		return
	}
	intent, err := h.intentService.GetByID(r.Context(), oid)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "GET_FAILED")
		return
	}
	if intent == nil {
		middleware.WriteError(w, http.StatusNotFound, "not found", "NOT_FOUND")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, intent)
}

func (h *IntentHandler) PatchIntent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid id", "BAD_REQUEST")
		return
	}
	var patch map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid body", "BAD_REQUEST")
		return
	}
	// Only allow specific fields
	allowed := map[string]bool{"title": true, "size": true, "sizePoints": true, "status": true, "category": true, "description": true}
	updates := bson.D{}
	for k, v := range patch {
		if allowed[k] {
			updates = append(updates, bson.E{Key: k, Value: v})
		}
	}
	if len(updates) == 0 {
		middleware.WriteError(w, http.StatusBadRequest, "no valid fields", "BAD_REQUEST")
		return
	}
	if err := h.intentService.Update(r.Context(), oid, updates); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *IntentHandler) Productivity(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 {
		days = 7
	}
	since := time.Now().UTC().AddDate(0, 0, -days)

	intents, err := h.intentService.List(r.Context(), "", "", "", since, 500)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "QUERY_FAILED")
		return
	}

	// Aggregate by project
	byProject := map[string]*services.ProductivityStats{}
	for _, intent := range intents {
		pid := intent.ProjectCode
		ps, ok := byProject[pid]
		if !ok {
			ps = &services.ProductivityStats{
				ProjectCode: pid,
				ByStatus:    map[string]int{},
				ByCategory:  map[string]int{},
			}
			byProject[pid] = ps
		}
		ps.IntentCount++
		if intent.Status == "delivered" {
			ps.PointsDelivered += intent.SizePoints
		}
		ps.ByStatus[intent.Status]++
		ps.ByCategory[intent.Category]++
		ps.TotalTokensIn += intent.TokensInput
		ps.TotalTokensOut += intent.TokensOutput
		ps.TotalWallClock += intent.WallClockSecs
	}

	// Enrich with project names/tags — skip deleted projects
	results := make([]services.ProductivityStats, 0, len(byProject))
	for _, ps := range byProject {
		proj, err := h.projectService.GetByCode(r.Context(), ps.ProjectCode)
		if err != nil || proj == nil {
			continue // project was deleted
		}
		ps.ProjectName = proj.Name
		ps.ProjectCode = proj.Code
		ps.Tags = proj.Tags
		results = append(results, *ps)
	}

	middleware.WriteJSON(w, http.StatusOK, results)
}

func (h *IntentHandler) Insights(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	tag := r.URL.Query().Get("tag")
	var since time.Time
	if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
		since, _ = time.Parse("2006-01-02", sinceStr)
	}
	if since.IsZero() {
		if days <= 0 {
			days = 30
		}
		since = time.Now().UTC().AddDate(0, 0, -days)
	}

	// If tag filter, resolve matching project codes
	var tagProjectCodes map[string]bool
	if tag != "" {
		tagProjectCodes = map[string]bool{}
		projects, _ := h.projectService.List(r.Context())
		for _, p := range projects {
			for _, t := range p.Tags {
				if t == tag {
					tagProjectCodes[p.Code] = true
					break
				}
			}
		}
	}

	allIntents, err := h.intentService.List(r.Context(), "", "", "", since, 1000)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "QUERY_FAILED")
		return
	}
	// Filter by tag if specified
	intents := allIntents
	if tagProjectCodes != nil {
		intents = nil
		for _, intent := range allIntents {
			if tagProjectCodes[intent.ProjectCode] {
				intents = append(intents, intent)
			}
		}
	}

	// Tokens per point by category
	type catAgg struct {
		TotalTokens int64 `json:"totalTokens"`
		TotalPoints int   `json:"totalPoints"`
		Count       int   `json:"count"`
	}
	byCategory := map[string]*catAgg{}
	byTechTag := map[string]*catAgg{}
	byUXLevel := map[string]*catAgg{}

	// Points per day
	dayPoints := map[string]int{}

	// Per-project aggregation
	type projectAgg struct {
		Name   string `json:"name"`
		Code   string `json:"code"`
		Points int    `json:"points"`
		Count  int    `json:"count"`
		Tokens int64  `json:"tokens"`
	}
	byProject := map[string]*projectAgg{}

	// Daily points by category (for stacked area chart)
	type dailyCatPoints struct {
		Categories map[string]int `json:"categories"`
		Total      int            `json:"total"`
	}
	dailyBreakdown := map[string]*dailyCatPoints{}

	// Delivery funnel
	funnel := map[string]struct {
		Count  int `json:"count"`
		Points int `json:"points"`
	}{}

	for _, intent := range intents {
		tokens := intent.TokensInput + intent.TokensOutput
		points := intent.SizePoints

		// By category
		ca, ok := byCategory[intent.Category]
		if !ok {
			ca = &catAgg{}
			byCategory[intent.Category] = ca
		}
		ca.TotalTokens += tokens
		ca.TotalPoints += points
		ca.Count++

		// By tech tag
		for _, tag := range intent.TechTags {
			ta, ok := byTechTag[tag]
			if !ok {
				ta = &catAgg{}
				byTechTag[tag] = ta
			}
			ta.TotalTokens += tokens
			ta.TotalPoints += points
			ta.Count++
		}

		// By UX judgment
		ua, ok := byUXLevel[intent.UXJudgment]
		if !ok {
			ua = &catAgg{}
			byUXLevel[intent.UXJudgment] = ua
		}
		ua.TotalTokens += tokens
		ua.TotalPoints += points
		ua.Count++

		// Daily points (total)
		day := intent.CompletedAt.Format("2006-01-02")
		if intent.Status == "delivered" {
			dayPoints[day] += points
		}

		// Daily by category
		dc, ok := dailyBreakdown[day]
		if !ok {
			dc = &dailyCatPoints{Categories: map[string]int{}}
			dailyBreakdown[day] = dc
		}
		if intent.Status == "delivered" {
			dc.Categories[intent.Category] += points
			dc.Total += points
		}

		// By project
		pid := intent.ProjectCode
		pa, ok := byProject[pid]
		if !ok {
			pa = &projectAgg{}
			if proj, err := h.projectService.GetByCode(r.Context(), pid); err == nil && proj != nil {
				pa.Name = proj.Name
				pa.Code = proj.Code
			}
			byProject[pid] = pa
		}
		if intent.Status == "delivered" {
			pa.Points += points
		}
		pa.Count++
		pa.Tokens += tokens

		// Funnel
		f := funnel[intent.Status]
		f.Count++
		f.Points += points
		funnel[intent.Status] = f
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"tokensByCategory":  byCategory,
		"tokensByTechTag":   byTechTag,
		"tokensByUXLevel":   byUXLevel,
		"dailyPoints":       dayPoints,
		"dailyByCategory":   dailyBreakdown,
		"byProject":         byProject,
		"funnel":            funnel,
		"totalIntents":      len(intents),
	})
}

func (h *IntentHandler) LinkPR(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid id", "BAD_REQUEST")
		return
	}
	var body struct {
		URL    string `json:"url"`
		Number int    `json:"number"`
		Repo   string `json:"repo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		middleware.WriteError(w, http.StatusBadRequest, "url is required", "BAD_REQUEST")
		return
	}
	pr := models.PRLink{URL: body.URL, Number: body.Number, Repo: body.Repo, State: "open"}
	updates := bson.D{{Key: "$push", Value: bson.D{{Key: "prLinks", Value: pr}}}}
	if err := h.intentService.UpdateRaw(r.Context(), oid, updates); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "UPDATE_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *IntentHandler) BackfillCount(w http.ResponseWriter, r *http.Request) {
	count, err := h.intentService.CountUnanalyzedSessions(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "QUERY_FAILED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{"remaining": count})
}

func (h *IntentHandler) Backfill(w http.ResponseWriter, r *http.Request) {
	slog.Info("backfill request received")
	if h.intentExtractor == nil {
		middleware.WriteError(w, http.StatusServiceUnavailable, "intent extraction requires ANTHROPIC_API_KEY", "NO_API_KEY")
		return
	}

	// Count total unanalyzed first
	allUnanalyzed, err := h.intentService.ListUnanalyzedSessions(r.Context(), 500)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, err.Error(), "QUERY_FAILED")
		return
	}

	if len(allUnanalyzed) == 0 {
		middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{"processed": 0, "remaining": 0, "message": "all sessions analyzed"})
		return
	}

	// Process up to 3 per batch (synchronous — each Haiku call takes ~2-3s)
	batch := allUnanalyzed
	if len(batch) > 3 {
		batch = batch[:3]
	}
	remaining := len(allUnanalyzed) - len(batch)

	processed := 0
	for _, session := range batch {
		// Load full entry with messages (the listing only has metadata)
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		fullEntry, err := h.intentService.GetHistoryEntry(ctx, session.ID)
		cancel()
		if err != nil || fullEntry == nil {
			slog.Error("backfill: failed to load history entry", "id", session.ID, "error", err)
			continue
		}
		ctx2, cancel2 := context.WithTimeout(r.Context(), 30*time.Second)
		if err := h.intentExtractor.ExtractFromSession(ctx2, fullEntry); err != nil {
			slog.Error("backfill extraction failed", "sessionID", session.ClaudeSessionID, "error", err)
		} else {
			processed++
		}
		cancel2()
	}
	slog.Info("intent backfill batch complete", "processed", processed, "remaining", remaining)

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"processing": processed,
		"remaining":  remaining,
		"message":    fmt.Sprintf("backfilled %d sessions (%d remaining)", processed, remaining),
	})
}
