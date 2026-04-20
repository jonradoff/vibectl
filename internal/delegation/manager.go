package delegation

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"sync"
	"time"

	vibectlclient "github.com/jonradoff/vibectl/internal/client"
	"github.com/jonradoff/vibectl/internal/events"
	"github.com/jonradoff/vibectl/internal/middleware"
)

// Status represents the current delegation state.
type Status struct {
	Enabled    bool   `json:"enabled"`
	URL        string `json:"url,omitempty"`
	User       string `json:"user,omitempty"`
	Healthy    bool   `json:"healthy"`
	VerifiedAt string `json:"verifiedAt,omitempty"`
}

// TestResult is returned by TestConnection.
type TestResult struct {
	Valid         bool   `json:"valid"`
	UserName      string `json:"userName,omitempty"`
	UserEmail     string `json:"userEmail,omitempty"`
	ServerVersion string `json:"serverVersion,omitempty"`
	Error         string `json:"error,omitempty"`
}

// Manager holds the delegation state and provides the proxy middleware.
type Manager struct {
	mu          sync.RWMutex
	enabled     bool
	remoteURL   string
	apiKey      string
	userName    string
	verifiedAt  time.Time
	healthy     bool
	proxy       *httputil.ReverseProxy
	eventStop   chan struct{}
	healthStop  chan struct{}
	bus         *events.Bus
}

// NewManager creates a new delegation manager.
func NewManager(bus *events.Bus) *Manager {
	return &Manager{bus: bus}
}

// Enable activates delegation to the given remote server.
func (m *Manager) Enable(remoteURL, apiKey, userName string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, err := NewDelegationProxy(remoteURL, apiKey)
	if err != nil {
		return fmt.Errorf("create proxy: %w", err)
	}

	// Stop any existing relay/health check
	m.stopInternal()

	m.enabled = true
	m.remoteURL = remoteURL
	m.apiKey = apiKey
	m.userName = userName
	m.verifiedAt = time.Now().UTC()
	m.healthy = true
	m.proxy = proxy

	// Start event relay
	m.eventStop = make(chan struct{})
	go vibectlclient.StartEventRelay(remoteURL, apiKey, m.bus, m.eventStop)

	// Start health check
	m.healthStop = make(chan struct{})
	go m.healthCheckLoop()

	slog.Info("delegation enabled", "remoteURL", remoteURL, "user", userName)
	return nil
}

// Disable deactivates delegation.
func (m *Manager) Disable() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopInternal()
	m.enabled = false
	m.remoteURL = ""
	m.apiKey = ""
	m.userName = ""
	m.proxy = nil
	slog.Info("delegation disabled")
}

func (m *Manager) stopInternal() {
	if m.eventStop != nil {
		close(m.eventStop)
		m.eventStop = nil
	}
	if m.healthStop != nil {
		close(m.healthStop)
		m.healthStop = nil
	}
}

// IsEnabled returns true if delegation is active.
func (m *Manager) IsEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.enabled
}

// IsHealthy returns true if the remote server is reachable.
func (m *Manager) IsHealthy() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.healthy
}

// GetAPIKey returns the stored API key (for making direct requests to the remote).
func (m *Manager) GetAPIKey() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.apiKey
}

// GetRemoteURL returns the remote server URL.
func (m *Manager) GetRemoteURL() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.remoteURL
}

// GetStatus returns the current delegation status.
func (m *Manager) GetStatus() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := Status{
		Enabled: m.enabled,
		URL:     m.remoteURL,
		User:    m.userName,
		Healthy: m.healthy,
	}
	if !m.verifiedAt.IsZero() {
		s.VerifiedAt = m.verifiedAt.Format(time.RFC3339)
	}
	return s
}

// ProxyMiddleware returns a chi middleware that intercepts delegated routes.
func (m *Manager) ProxyMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !m.IsEnabled() {
				next.ServeHTTP(w, r) // isolated mode — all local
				return
			}
			if IsLocalRoute(r.URL.Path) {
				next.ServeHTTP(w, r) // local even in delegation
				return
			}
			// Allow frontend to force local view with header
			if r.Header.Get("X-Vibectl-View") == "local" {
				next.ServeHTTP(w, r)
				return
			}
			if !m.IsHealthy() {
				middleware.WriteError(w, http.StatusServiceUnavailable,
					"Remote server unavailable. Sessions and terminals continue to work locally.",
					"DELEGATION_UNAVAILABLE")
				return
			}
			m.mu.RLock()
			proxy := m.proxy
			m.mu.RUnlock()
			if proxy == nil {
				middleware.WriteError(w, http.StatusServiceUnavailable, "delegation proxy not initialized", "DELEGATION_UNAVAILABLE")
				return
			}
			proxy.ServeHTTP(w, r)
		})
	}
}

// TestConnection validates a remote URL and API key without activating delegation.
func TestConnection(remoteURL, apiKey string) TestResult {
	client := &http.Client{Timeout: 10 * time.Second}

	// Check healthz
	healthReq, _ := http.NewRequest("GET", remoteURL+"/healthz", nil)
	healthResp, err := client.Do(healthReq)
	if err != nil {
		return TestResult{Error: fmt.Sprintf("Cannot reach server: %v", err)}
	}
	healthResp.Body.Close()
	if healthResp.StatusCode != 200 {
		return TestResult{Error: fmt.Sprintf("Server health check failed (HTTP %d)", healthResp.StatusCode)}
	}

	// Validate API key via /api/v1/auth/me
	meReq, _ := http.NewRequest("GET", remoteURL+"/api/v1/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+apiKey)
	meResp, err := client.Do(meReq)
	if err != nil {
		return TestResult{Error: fmt.Sprintf("Failed to verify API key: %v", err)}
	}
	defer meResp.Body.Close()
	if meResp.StatusCode == 401 {
		return TestResult{Error: "Invalid API key"}
	}
	if meResp.StatusCode != 200 {
		return TestResult{Error: fmt.Sprintf("API key verification failed (HTTP %d)", meResp.StatusCode)}
	}

	body, _ := io.ReadAll(meResp.Body)
	var user struct {
		DisplayName string `json:"displayName"`
		Email       string `json:"email"`
	}
	json.Unmarshal(body, &user)

	// Check remote mode — reject if remote is itself delegated
	modeReq, _ := http.NewRequest("GET", remoteURL+"/api/v1/mode", nil)
	modeResp, err := client.Do(modeReq)
	if err == nil {
		defer modeResp.Body.Close()
		var modeInfo struct {
			Mode              string `json:"mode"`
			DelegationEnabled bool   `json:"delegationEnabled"`
		}
		modeBody, _ := io.ReadAll(modeResp.Body)
		json.Unmarshal(modeBody, &modeInfo)
		if modeInfo.DelegationEnabled {
			return TestResult{Error: "Cannot delegate to a server that is itself delegated"}
		}
	}

	return TestResult{
		Valid:     true,
		UserName:  user.DisplayName,
		UserEmail: user.Email,
	}
}

// healthCheckLoop pings the remote server periodically.
func (m *Manager) healthCheckLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	client := &http.Client{Timeout: 10 * time.Second}

	for {
		select {
		case <-m.healthStop:
			return
		case <-ticker.C:
			m.mu.RLock()
			url := m.remoteURL
			m.mu.RUnlock()

			req, _ := http.NewRequest("GET", url+"/healthz", nil)
			resp, err := client.Do(req)
			healthy := err == nil && resp != nil && resp.StatusCode == 200
			if resp != nil {
				resp.Body.Close()
			}

			m.mu.Lock()
			if m.healthy != healthy {
				if healthy {
					slog.Info("delegation remote recovered")
				} else {
					slog.Warn("delegation remote unreachable")
				}
			}
			m.healthy = healthy
			m.mu.Unlock()
		}
	}
}
