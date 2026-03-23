package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// PathStore stores per-project local path overrides for client mode.
// Data is persisted to a JSON file so it survives restarts.
type PathStore struct {
	mu       sync.RWMutex
	paths    map[string]string // projectID → localPath
	filePath string
}

// NewPathStore loads (or creates) the path store at the given data directory.
func NewPathStore(dataDir string) (*PathStore, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	filePath := filepath.Join(dataDir, "local_paths.json")
	ps := &PathStore{
		paths:    make(map[string]string),
		filePath: filePath,
	}
	// Load existing data if present; silently ignore missing file.
	if data, err := os.ReadFile(filePath); err == nil {
		_ = json.Unmarshal(data, &ps.paths)
	}
	return ps, nil
}

// Get returns the local path for a project, or "" if not set.
func (ps *PathStore) Get(projectID string) string {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	return ps.paths[projectID]
}

// GetAll returns a copy of all path mappings (projectID → localPath).
func (ps *PathStore) GetAll() map[string]string {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	out := make(map[string]string, len(ps.paths))
	for k, v := range ps.paths {
		out[k] = v
	}
	return out
}

// Set stores a local path override for a project and persists to disk.
func (ps *PathStore) Set(projectID, localPath string) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.paths[projectID] = localPath
	return ps.save()
}

// Delete removes a local path override and persists to disk.
func (ps *PathStore) Delete(projectID string) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	delete(ps.paths, projectID)
	return ps.save()
}

// save writes the current state to disk (must be called with mu held).
func (ps *PathStore) save() error {
	data, err := json.MarshalIndent(ps.paths, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(ps.filePath, data, 0600)
}
