package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
	"github.com/jonradoff/vibectl/internal/terminal"
)

// AdminHandler handles administrative operations like rebuild/restart and auth.
type AdminHandler struct {
	sourceDir    string
	onBeforeExec func()
	adminService *services.AdminService
}

// NewAdminHandler creates an admin handler.
func NewAdminHandler(sourceDir string, onBeforeExec func(), adminService *services.AdminService) *AdminHandler {
	return &AdminHandler{
		sourceDir:    sourceDir,
		onBeforeExec: onBeforeExec,
		adminService: adminService,
	}
}

// AuthStatus handles GET /api/v1/admin/auth-status.
// Public endpoint. Returns whether a password is configured and whether the supplied token is valid.
func (h *AdminHandler) AuthStatus(w http.ResponseWriter, r *http.Request) {
	has, err := h.adminService.HasPassword(r.Context())
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "internal error", "INTERNAL_ERROR")
		return
	}

	tokenValid := false
	if !has {
		// No password configured — open access, treat as authenticated.
		tokenValid = true
	} else {
		auth := r.Header.Get("Authorization")
		token := ""
		if strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimPrefix(auth, "Bearer ")
		} else {
			token = r.Header.Get("X-Vibectl-Token")
		}
		if token != "" {
			ok, _ := h.adminService.VerifyToken(r.Context(), token)
			tokenValid = ok
		}
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"passwordSet": has,
		"tokenValid":  tokenValid,
	})
}

// Rebuild handles POST /api/v1/admin/rebuild.
func (h *AdminHandler) Rebuild(w http.ResponseWriter, r *http.Request) {
	slog.Info("rebuild requested")
	terminal.GetGlobalBroadcast().Send("server_restarting")
	time.Sleep(200 * time.Millisecond)

	slog.Info("rebuilding server binary")
	buildCmd := exec.Command("go", "build", "-o", "vibectl-server", "./cmd/server/")
	buildCmd.Dir = h.sourceDir
	buildCmd.Env = os.Environ()
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr

	if err := buildCmd.Run(); err != nil {
		slog.Error("rebuild failed", "error", err)
		middleware.WriteError(w, http.StatusInternalServerError,
			fmt.Sprintf("build failed: %v", err), "BUILD_ERROR")
		return
	}

	slog.Info("rebuild successful, restarting")
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "restarting"})

	go func() {
		time.Sleep(500 * time.Millisecond)
		if h.onBeforeExec != nil {
			h.onBeforeExec()
		}
		binary := h.sourceDir + "/vibectl-server"
		slog.Info("exec-ing new binary", "path", binary)
		if err := execSelf(binary); err != nil {
			slog.Error("failed to exec new binary, falling back to exit", "error", err)
			os.Exit(0)
		}
	}()
}

// SelfInfo handles GET /api/v1/admin/self-info.
func (h *AdminHandler) SelfInfo(w http.ResponseWriter, r *http.Request) {
	middleware.WriteJSON(w, http.StatusOK, map[string]string{
		"sourceDir": h.sourceDir,
	})
}

// Login handles POST /api/v1/admin/login.
// Body: { "password": "..." }
// Returns: { "token": "..." }
func (h *AdminHandler) Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password == "" {
		middleware.WriteError(w, http.StatusBadRequest, "password is required", "BAD_REQUEST")
		return
	}

	token, err := h.adminService.Login(r.Context(), body.Password)
	if err != nil {
		middleware.WriteError(w, http.StatusUnauthorized, err.Error(), "UNAUTHORIZED")
		return
	}
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"token": token})
}

// SetPassword handles POST /api/v1/admin/set-password.
// Body: { "currentPassword": "...", "newPassword": "..." }
// On first run (bootstrap), currentPassword may be empty.
func (h *AdminHandler) SetPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}
	if body.NewPassword == "" {
		middleware.WriteError(w, http.StatusBadRequest, "newPassword is required", "BAD_REQUEST")
		return
	}
	if len(body.NewPassword) < 8 {
		middleware.WriteError(w, http.StatusBadRequest, "newPassword must be at least 8 characters", "BAD_REQUEST")
		return
	}

	token, err := h.adminService.SetPassword(r.Context(), body.CurrentPassword, body.NewPassword)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "SET_PASSWORD_FAILED")
		return
	}

	slog.Info("admin password updated")
	middleware.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "token": token})
}
