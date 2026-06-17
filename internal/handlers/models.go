package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
)

// ModelsHandler exposes GET /api/v1/models — the list of Claude models the
// account has access to, fetched lazily from Anthropic when the UI opens a
// picker. Results are cached in-memory to avoid hammering the API on every
// dropdown open.
type ModelsHandler struct {
	apiKey string
	cache  modelCache
}

// AnthropicModel mirrors a single entry from Anthropic's GET /v1/models.
type AnthropicModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
	Type        string `json:"type,omitempty"`
	CreatedAt   string `json:"createdAt,omitempty"`
}

type modelCache struct {
	mu        sync.Mutex
	models    []AnthropicModel
	fetchedAt time.Time
	ttl       time.Duration
}

// NewModelsHandler — pass the server-level ANTHROPIC_API_KEY. The endpoint
// returns 503 if no key is configured.
func NewModelsHandler(apiKey string) *ModelsHandler {
	return &ModelsHandler{
		apiKey: apiKey,
		cache:  modelCache{ttl: 5 * time.Minute},
	}
}

// Routes returns the chi sub-router.
func (h *ModelsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.List)
	return r
}

// List returns the available Claude models.
func (h *ModelsHandler) List(w http.ResponseWriter, r *http.Request) {
	if h.apiKey == "" {
		middleware.WriteError(w, http.StatusServiceUnavailable,
			"ANTHROPIC_API_KEY not configured on this server — model picker is unavailable",
			"NO_API_KEY")
		return
	}

	// Allow ?refresh=1 to bypass cache.
	refresh := r.URL.Query().Get("refresh") == "1"

	models, err := h.cache.getOrFetch(r.Context(), h.apiKey, refresh)
	if err != nil {
		middleware.WriteError(w, http.StatusBadGateway,
			fmt.Sprintf("failed to fetch models from Anthropic: %v", err),
			"MODELS_FETCH_FAILED")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]any{
		"models":    models,
		"fetchedAt": h.cache.fetchedAt.UTC(),
	})
}

// getOrFetch returns cached models if fresh, otherwise fetches from Anthropic.
// Concurrent callers share the same fetch — only one network call in flight.
func (c *modelCache) getOrFetch(ctx context.Context, apiKey string, refresh bool) ([]AnthropicModel, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !refresh && len(c.models) > 0 && time.Since(c.fetchedAt) < c.ttl {
		return c.models, nil
	}

	models, err := fetchAnthropicModels(ctx, apiKey)
	if err != nil {
		// Serve stale on fetch failure so the UI degrades gracefully.
		if len(c.models) > 0 {
			return c.models, nil
		}
		return nil, err
	}

	c.models = models
	c.fetchedAt = time.Now()
	return models, nil
}

// fetchAnthropicModels calls Anthropic's GET /v1/models and returns a sorted list.
// Pagination: the Anthropic API uses cursor-based pagination but in practice
// returns the full list of available models in one page. If that ever changes,
// add cursor follow-up here.
func fetchAnthropicModels(ctx context.Context, apiKey string) ([]AnthropicModel, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.anthropic.com/v1/models?limit=100", nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("anthropic /v1/models returned %d", resp.StatusCode)
	}

	var body struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
			Type        string `json:"type"`
			CreatedAt   string `json:"created_at"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	out := make([]AnthropicModel, 0, len(body.Data))
	for _, m := range body.Data {
		out = append(out, AnthropicModel{
			ID:          m.ID,
			DisplayName: m.DisplayName,
			Type:        m.Type,
			CreatedAt:   m.CreatedAt,
		})
	}
	// Sort newest first by CreatedAt (lexically — ISO 8601 sorts correctly).
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out, nil
}
