package services

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
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

// ValidateWebhookURL returns an error if the URL targets a private/loopback address (SSRF prevention).
func ValidateWebhookURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("webhook URL must use http or https")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("webhook URL missing host")
	}
	// Resolve hostname to IPs and block private ranges
	ips, err := net.LookupHost(host)
	if err != nil {
		// If we can't resolve, block it — don't allow unresolvable hostnames
		return fmt.Errorf("could not resolve webhook host %q: %w", host, err)
	}
	for _, ipStr := range ips {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			continue
		}
		if isPrivateIP(ip) {
			return fmt.Errorf("webhook URL must not target a private or loopback address")
		}
	}
	return nil
}

// isPrivateIP reports whether ip is in a private, loopback, or link-local range.
func isPrivateIP(ip net.IP) bool {
	private := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"127.0.0.0/8",
		"::1/128",
		"fc00::/7",
		"169.254.0.0/16", // AWS metadata / link-local
		"fd00::/8",
	}
	for _, cidr := range private {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	// Also block bare "localhost" and similar
	if strings.EqualFold(ip.String(), "::1") || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return true
	}
	return false
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
