package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
)

// RemoteChatSessionService implements terminal.ChatSessionPersister by calling
// the remote VibeCtl server's chat-session API endpoints.
type RemoteChatSessionService struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

func NewRemoteChatSessionService(baseURL, apiKey string) *RemoteChatSessionService {
	return &RemoteChatSessionService{
		baseURL: baseURL,
		apiKey:  apiKey,
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *RemoteChatSessionService) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, s.baseURL+path, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return s.client.Do(req)
}

func (s *RemoteChatSessionService) Upsert(ctx context.Context, projectID, claudeSessionID, localPath string, messages []json.RawMessage) error {
	payload := map[string]any{
		"claudeSessionId": claudeSessionID,
		"localPath":       localPath,
		"messages":        messages,
	}
	resp, err := s.do(ctx, http.MethodPost, "/api/v1/projects/"+projectID+"/chat-session/upsert", payload)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("upsert chat session: status %d", resp.StatusCode)
	}
	return nil
}

func (s *RemoteChatSessionService) MarkResumable(ctx context.Context, projectID string) error {
	resp, err := s.do(ctx, http.MethodPost, "/api/v1/projects/"+projectID+"/chat-session/mark-resumable", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("mark resumable: status %d", resp.StatusCode)
	}
	return nil
}

func (s *RemoteChatSessionService) MarkDead(ctx context.Context, projectID string) error {
	resp, err := s.do(ctx, http.MethodPost, "/api/v1/projects/"+projectID+"/chat-session/mark-dead", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("mark dead: status %d", resp.StatusCode)
	}
	return nil
}

// GetLastSessionID is a best-effort remote lookup. Client mode's remote
// server doesn't currently expose a dedicated endpoint for the "return the
// last known claudeSessionId regardless of status" query — the existing
// GetResumable already returns the ID when status is resumable or active.
// Return "" here; the caller's fallback logic will then rely on the
// history-archive session-id search, which is provider-agnostic.
func (s *RemoteChatSessionService) GetLastSessionID(ctx context.Context, projectID string) (string, error) {
	return "", nil
}

// ClearSession marks dead AND removes the persisted Claude session ID, so the
// next launch starts fresh instead of trying to resume an orphaned ID. Falls
// back to MarkDead if the remote doesn't have the dedicated endpoint — the
// session ID will reset on the next successful spawn either way.
func (s *RemoteChatSessionService) ClearSession(ctx context.Context, projectID string) error {
	resp, err := s.do(ctx, http.MethodPost, "/api/v1/projects/"+projectID+"/chat-session/clear", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return s.MarkDead(ctx, projectID)
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("clear session: status %d", resp.StatusCode)
	}
	return nil
}

func (s *RemoteChatSessionService) GetResumable(ctx context.Context, projectID string) (*models.ChatSessionState, error) {
	resp, err := s.do(ctx, http.MethodGet, "/api/v1/projects/"+projectID+"/chat-session/resumable", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("get resumable: status %d", resp.StatusCode)
	}
	// Server returns null JSON when no session exists
	var state models.ChatSessionState
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		return nil, nil // null body = no session
	}
	if state.ProjectCode == "" {
		return nil, nil
	}
	return &state, nil
}
