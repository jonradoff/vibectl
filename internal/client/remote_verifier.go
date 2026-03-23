package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// RemoteTokenVerifier verifies session tokens against a remote vibectl server.
// Used in client mode when there is no local MongoDB.
type RemoteTokenVerifier struct {
	remoteURL  string
	httpClient *http.Client
}

// NewRemoteTokenVerifier creates a verifier that calls remoteURL/api/v1/auth/me.
func NewRemoteTokenVerifier(remoteURL string) *RemoteTokenVerifier {
	return &RemoteTokenVerifier{
		remoteURL: remoteURL,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

// userResponse is the JSON shape returned by /api/v1/auth/me.
type userResponse struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	GlobalRole  string `json:"globalRole"`
	Disabled    bool   `json:"disabled"`
}

// Verify calls the remote /api/v1/auth/me with the given bearer token.
// Returns the user if valid, or nil without an error if the token is invalid/expired.
func (v *RemoteTokenVerifier) Verify(ctx context.Context, rawToken string) (*models.User, error) {
	if rawToken == "" {
		return nil, nil
	}
	req, err := http.NewRequestWithContext(ctx, "GET", v.remoteURL+"/api/v1/auth/me", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+rawToken)

	resp, err := v.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("remote token verify: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, nil // token invalid — not an error
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote token verify: unexpected status %d", resp.StatusCode)
	}

	var ur userResponse
	if err := json.NewDecoder(resp.Body).Decode(&ur); err != nil {
		return nil, fmt.Errorf("remote token verify: decode user: %w", err)
	}

	oid, err := bson.ObjectIDFromHex(ur.ID)
	if err != nil {
		return nil, fmt.Errorf("remote token verify: parse user id: %w", err)
	}

	user := &models.User{
		ID:          oid,
		DisplayName: ur.DisplayName,
		Email:       ur.Email,
		GlobalRole:  models.GlobalRole(ur.GlobalRole),
		Disabled:    ur.Disabled,
	}
	return user, nil
}
