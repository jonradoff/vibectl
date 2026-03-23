package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// RemoteChatHistoryService implements terminal.ChatHistoryArchiver by calling
// the remote VibeCtl server's chat-session/archive endpoint.
type RemoteChatHistoryService struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

func NewRemoteChatHistoryService(baseURL, apiKey string) *RemoteChatHistoryService {
	return &RemoteChatHistoryService{
		baseURL: baseURL,
		apiKey:  apiKey,
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *RemoteChatHistoryService) Archive(ctx context.Context, projectID, claudeSessionID string, messages []json.RawMessage, startedAt time.Time) error {
	payload := map[string]any{
		"claudeSessionId": claudeSessionID,
		"messages":        messages,
		"startedAt":       startedAt.UTC().Format(time.RFC3339),
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(payload); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/api/v1/projects/"+projectID+"/chat-session/archive", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("archive chat history: status %d", resp.StatusCode)
	}
	return nil
}
