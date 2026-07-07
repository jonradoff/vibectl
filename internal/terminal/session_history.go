package terminal

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// findSessionAnywhere searches every ~/.claude/projects/*/<sessionID>.jsonl
// for a match and returns the first hit. Used as a fallback when the direct
// encoded-path lookup misses — typically because the vibectl project's
// localPath was renamed/moved after the conversation was already recorded
// under the old encoding. Returns "" if no match exists.
func findSessionAnywhere(home, sessionID string) string {
	root := filepath.Join(home, ".claude", "projects")
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	fname := sessionID + ".jsonl"
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(root, e.Name(), fname)
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
}

// ensureSessionLinkedAtExpectedPath makes a session's JSONL discoverable at
// the expected encoded-path location for a given local path, by symlinking
// the actually-found file (from a cross-dir search) into the direct-encoded
// dir. This lets `claude --resume <sessionID>` succeed after a project move
// — without the link, Claude Code refuses because it only looks under the
// current cwd's encoded dir.
//
// Idempotent: no-op when foundPath already IS the expected path or the link
// already exists.
func ensureSessionLinkedAtExpectedPath(localPath, sessionID, foundPath string) error {
	if localPath == "" || sessionID == "" || foundPath == "" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	encoded := strings.ReplaceAll(localPath, "/", "-")
	if !strings.HasPrefix(encoded, "-") {
		encoded = "-" + encoded
	}
	dir := filepath.Join(home, ".claude", "projects", encoded)
	link := filepath.Join(dir, sessionID+".jsonl")

	// Already at the expected path — nothing to do.
	if foundPath == link {
		return nil
	}
	// Already exists (link or file). If a symlink, assume it's ours and OK;
	// if a real file, don't overwrite it — Claude Code has a session at that
	// location already, so `--resume` will follow it, not ours.
	if info, err := os.Lstat(link); err == nil {
		_ = info
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.Symlink(foundPath, link)
}

// encodedProjectDir returns the ~/.claude/projects/<encoded>/ directory for
// a given local path. Returns "" if the home dir isn't resolvable.
func encodedProjectDir(localPath string) string {
	if localPath == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	encoded := strings.ReplaceAll(localPath, "/", "-")
	if !strings.HasPrefix(encoded, "-") {
		encoded = "-" + encoded
	}
	return filepath.Join(home, ".claude", "projects", encoded)
}

// latestOnDiskSession scans Claude Code's project directory for the newest
// *.jsonl session file and returns its session ID (the filename without
// extension) plus mtime. Returns "" if none exist. Used to recover the
// last conversation when the DB has no active/resumable record (e.g. we
// marked it dead to unblock the user, or a fresh install lost track).
func latestOnDiskSession(localPath string) (sessionID string, mtime time.Time) {
	dir := encodedProjectDir(localPath)
	if dir == "" {
		return "", time.Time{}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", time.Time{}
	}
	var newestID string
	var newestTime time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newestTime) {
			newestTime = info.ModTime()
			newestID = strings.TrimSuffix(e.Name(), ".jsonl")
		}
	}
	return newestID, newestTime
}

// loadOnDiskHistory reads Claude Code's authoritative conversation log for a
// session and returns each user/assistant line as a JSON message ready to
// broadcast to a WebSocket subscriber.
//
// Claude Code stores conversations at:
//
//	~/.claude/projects/<encodedPath>/<sessionID>.jsonl
//
// where <encodedPath> is the local path with every "/" replaced by "-".
// The file contains one JSON object per line; we keep only "user" and
// "assistant" entries (skipping housekeeping like queue-operation).
//
// Fallback: if the file isn't found at the expected encoded-path dir (e.g.
// the project's localPath was moved/renamed after the conversation was
// recorded), scan all ~/.claude/projects/*/<sessionID>.jsonl for a match.
// This lets a moved project keep its history without any manual surgery.
//
// Returns (messages, path, error). If the file doesn't exist anywhere,
// returns an empty slice with err == nil — callers should fall back to the
// in-memory buffer in that case.
func loadOnDiskHistory(localPath, sessionID string) ([]json.RawMessage, string, error) {
	if localPath == "" || sessionID == "" {
		return nil, "", nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, "", err
	}
	encoded := strings.ReplaceAll(localPath, "/", "-")
	// Guarantee the leading dash Claude Code uses for absolute paths.
	if !strings.HasPrefix(encoded, "-") {
		encoded = "-" + encoded
	}
	path := filepath.Join(home, ".claude", "projects", encoded, sessionID+".jsonl")

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Cross-dir fallback for moved/renamed projects.
			if alt := findSessionAnywhere(home, sessionID); alt != "" {
				path = alt
				f, err = os.Open(alt)
				if err != nil {
					return nil, path, err
				}
			} else {
				return nil, path, nil
			}
		} else {
			return nil, path, err
		}
	}
	defer f.Close()

	var out []json.RawMessage
	scanner := bufio.NewScanner(f)
	// Individual JSONL lines can be huge (large tool_result payloads).
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var peek struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(line, &peek); err != nil {
			continue
		}
		if peek.Type != "user" && peek.Type != "assistant" {
			continue
		}
		buf := make([]byte, len(line))
		copy(buf, line)
		out = append(out, buf)
	}
	if err := scanner.Err(); err != nil {
		return out, path, err
	}
	return out, path, nil
}
