package services

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// WebhookService fires webhook payloads for project events.
type WebhookService struct {
	db     *mongo.Database
	client *http.Client
}

// WebhookPayload is the JSON body sent to webhook endpoints.
type WebhookPayload struct {
	Event     string         `json:"event"`
	ProjectID string         `json:"projectId"`
	Timestamp time.Time      `json:"timestamp"`
	Data      map[string]any `json:"data"`
}

// NewWebhookService creates a new WebhookService.
func NewWebhookService(db *mongo.Database) *WebhookService {
	return &WebhookService{
		db:     db,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Fire sends a webhook event to all configured endpoints for the given project that subscribe to this event.
// It runs each delivery in its own goroutine and does not block.
func (s *WebhookService) Fire(ctx context.Context, projectID bson.ObjectID, event models.WebhookEvent, data map[string]any) {
	var project models.Project
	err := s.db.Collection("projects").FindOne(ctx, bson.D{{Key: "_id", Value: projectID}}).Decode(&project)
	if err != nil {
		return
	}
	payload := WebhookPayload{
		Event:     string(event),
		ProjectID: projectID.Hex(),
		Timestamp: time.Now().UTC(),
		Data:      data,
	}
	body, _ := json.Marshal(payload)
	for _, wh := range project.Webhooks {
		subscribed := false
		for _, e := range wh.Events {
			if e == event {
				subscribed = true
				break
			}
		}
		if !subscribed {
			continue
		}
		go func(wh models.WebhookConfig) {
			req, err := http.NewRequestWithContext(context.Background(), "POST", wh.URL, bytes.NewReader(body))
			if err != nil {
				slog.Warn("webhook: invalid URL", "url", wh.URL, "error", err)
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Vibectl-Event", string(event))
			if wh.Secret != "" {
				mac := hmac.New(sha256.New, []byte(wh.Secret))
				mac.Write(body)
				req.Header.Set("X-Vibectl-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
			}
			resp, err := s.client.Do(req)
			if err != nil {
				slog.Warn("webhook: delivery failed", "url", wh.URL, "error", err)
				return
			}
			resp.Body.Close()
			if resp.StatusCode >= 400 {
				slog.Warn("webhook: non-2xx response", "url", wh.URL, "status", resp.StatusCode)
			}
		}(wh)
	}
}
