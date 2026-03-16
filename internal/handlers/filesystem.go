package handlers

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type FilesystemHandler struct {
	projectService     *services.ProjectService
	activityLogService *services.ActivityLogService
}

func NewFilesystemHandler(ps *services.ProjectService, als *services.ActivityLogService) *FilesystemHandler {
	return &FilesystemHandler{projectService: ps, activityLogService: als}
}

// DirEntry represents a file or directory in the listing.
type DirEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`  // relative to project root
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size,omitempty"`
	ModTime string `json:"modTime,omitempty"` // ISO 8601 timestamp
}

// resolveAndValidate returns the absolute path and ensures it's within the project root.
func (h *FilesystemHandler) resolveAndValidate(r *http.Request) (string, string, error) {
	projectID := chi.URLParam(r, "id")
	project, err := h.projectService.GetByID(r.Context(), projectID)
	if err != nil {
		return "", "", fmt.Errorf("project not found")
	}

	localPath := project.Links.LocalPath
	if localPath == "" {
		return "", "", fmt.Errorf("no local path configured")
	}

	root, err := filepath.Abs(localPath)
	if err != nil {
		return "", "", fmt.Errorf("invalid local path")
	}

	// Get the relative path from query param
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		relPath = "."
	}

	// Clean and resolve
	target := filepath.Join(root, filepath.Clean("/"+relPath))
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", "", fmt.Errorf("invalid path")
	}

	// Security: ensure we're still within root
	if !strings.HasPrefix(absTarget, root) {
		return "", "", fmt.Errorf("path outside project directory")
	}

	return root, absTarget, nil
}

// ListDir returns directory contents.
func (h *FilesystemHandler) ListDir(w http.ResponseWriter, r *http.Request) {
	root, absPath, err := h.resolveAndValidate(r)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "PATH_ERROR")
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, "path not found", "NOT_FOUND")
		return
	}
	if !info.IsDir() {
		middleware.WriteError(w, http.StatusBadRequest, "not a directory", "NOT_DIR")
		return
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to read directory", "READ_DIR_ERROR")
		return
	}

	var result []DirEntry
	for _, entry := range entries {
		name := entry.Name()
		// Skip hidden files/dirs except important dotfiles
		if strings.HasPrefix(name, ".") {
			keep := map[string]bool{".env.example": true, ".gitignore": true, ".dockerignore": true, ".eslintrc": true, ".prettierrc": true}
			if !keep[name] && !keep[strings.ToLower(name)] {
				continue
			}
		}
		// Skip bulky directories
		skip := map[string]bool{"node_modules": true, ".git": true, "vendor": true, ".vite": true, "__pycache__": true, ".next": true, ".cache": true, "coverage": true}
		if entry.IsDir() && skip[name] {
			continue
		}

		relPath, _ := filepath.Rel(root, filepath.Join(absPath, name))
		var size int64
		var modTime string
		if fi, err := entry.Info(); err == nil {
			size = fi.Size()
			modTime = fi.ModTime().UTC().Format("2006-01-02T15:04:05Z")
		}

		result = append(result, DirEntry{
			Name:    name,
			Path:    relPath,
			IsDir:   entry.IsDir(),
			Size:    size,
			ModTime: modTime,
		})
	}

	// Sort: dirs first, then alphabetical
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})

	middleware.WriteJSON(w, http.StatusOK, result)
}

// ReadFile returns file contents.
func (h *FilesystemHandler) ReadFile(w http.ResponseWriter, r *http.Request) {
	_, absPath, err := h.resolveAndValidate(r)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "PATH_ERROR")
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		middleware.WriteError(w, http.StatusNotFound, "file not found", "NOT_FOUND")
		return
	}
	if info.IsDir() {
		middleware.WriteError(w, http.StatusBadRequest, "path is a directory", "IS_DIR")
		return
	}

	// Limit file size to 5MB
	if info.Size() > 5*1024*1024 {
		middleware.WriteError(w, http.StatusBadRequest, "file too large (max 5MB)", "FILE_TOO_LARGE")
		return
	}

	content, err := os.ReadFile(absPath)
	if err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to read file", "READ_ERROR")
		return
	}

	// Detect if binary
	if isBinary(content) {
		middleware.WriteError(w, http.StatusBadRequest, "binary file cannot be displayed", "BINARY_FILE")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{
		"path":    r.URL.Query().Get("path"),
		"content": string(content),
		"size":    info.Size(),
		"mode":    info.Mode().Perm().String(),
	})
}

// WriteFile saves file contents.
func (h *FilesystemHandler) WriteFile(w http.ResponseWriter, r *http.Request) {
	_, absPath, err := h.resolveAndValidate(r)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, err.Error(), "PATH_ERROR")
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid request body", "INVALID_BODY")
		return
	}

	// Get existing file permissions or default to 0644
	var perm fs.FileMode = 0644
	if info, err := os.Stat(absPath); err == nil {
		perm = info.Mode().Perm()
	}

	if err := os.WriteFile(absPath, []byte(req.Content), perm); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, "failed to write file", "WRITE_ERROR")
		return
	}

	// Log the file edit
	if h.activityLogService != nil {
		relPath := r.URL.Query().Get("path")
		projectID := chi.URLParam(r, "id")
		if oid, err := bson.ObjectIDFromHex(projectID); err == nil {
			h.activityLogService.LogAsync("file_edit", "Edited file: "+relPath, &oid, "", nil)
		}
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

// EnsureDir creates a directory (and parents) if it doesn't exist.
// Accepts {"path": "/absolute/path"} in the request body.
func (h *FilesystemHandler) EnsureDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		middleware.WriteError(w, http.StatusBadRequest, "path is required", "INVALID_BODY")
		return
	}

	absPath, err := filepath.Abs(req.Path)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid path", "INVALID_PATH")
		return
	}

	// Check if it already exists
	if info, err := os.Stat(absPath); err == nil {
		if info.IsDir() {
			middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{"created": false, "exists": true})
			return
		}
		middleware.WriteError(w, http.StatusConflict, "path exists but is not a directory", "NOT_DIR")
		return
	}

	if err := os.MkdirAll(absPath, 0755); err != nil {
		middleware.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create directory: %v", err), "MKDIR_ERROR")
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{"created": true, "exists": true})
}

// CheckDir checks if a directory exists.
// Query param: ?path=/absolute/path
func (h *FilesystemHandler) CheckDir(w http.ResponseWriter, r *http.Request) {
	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		middleware.WriteError(w, http.StatusBadRequest, "path query param is required", "INVALID_PATH")
		return
	}

	absPath, err := filepath.Abs(dirPath)
	if err != nil {
		middleware.WriteError(w, http.StatusBadRequest, "invalid path", "INVALID_PATH")
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{"exists": false})
		return
	}

	middleware.WriteJSON(w, http.StatusOK, map[string]interface{}{"exists": info.IsDir()})
}

// isBinary checks if content appears to be binary.
func isBinary(content []byte) bool {
	// Check first 512 bytes for null bytes
	check := content
	if len(check) > 512 {
		check = check[:512]
	}
	for _, b := range check {
		if b == 0 {
			return true
		}
	}
	return false
}
