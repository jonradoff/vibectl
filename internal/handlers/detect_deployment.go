package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
)

// DetectedTarget is a single candidate deployment target surfaced to the UI.
type DetectedTarget struct {
	models.DeploymentConfig
	// Signals records the filesystem evidence for this candidate (for the UI's
	// "detected from …" hint).
	Signals []string `json:"signals,omitempty"`
}

// DetectDeploymentResponse is the multi-target detection payload.
type DetectDeploymentResponse struct {
	Targets []DetectedTarget `json:"targets"`
	// Signals summarises everything we noticed in the directory (informational).
	Signals map[string]bool `json:"signals"`
	// AWSDocPath, if set, is the repo-relative path to an AWS docs file
	// (aws.md / AWS.md / docs/aws.md) — surface as a link, don't treat as config.
	AWSDocPath string `json:"awsDocPath,omitempty"`
}

// DetectDeploymentTargets scans a project directory and returns a list of
// candidate deployment targets. It's a superset of DetectProjectScripts —
// callers who only want the legacy single-target shape can still use that.
//
// Detection rules:
//   1. `fly.toml`           → one candidate, provider "flyio". Marked isLegacy
//                             if any AWS candidates were also detected.
//   2. `build/ecs/*.json*`, `deploy/ecs/*.json*`, `.aws/ecs/*.json*`, or
//      `task-definition*.json` / `taskdef*.json` at the root
//                            → provider "aws". Each matching file becomes a
//                              candidate (usually paired with its config yaml).
//   3. `config/*.yaml` — one target per env file (filenames as target names,
//      skipping local/example/fly-* by default). Merged with the AWS
//      candidates from rule 2 when possible.
//   4. `deploy.sh`, `start.sh`, `stop.sh` — populate the corresponding command
//      fields on the default target.
//   5. `aws.md` / `AWS.md` / `docs/aws.md` → returned as awsDocPath, not a target.
//   6. `.github/workflows/*.yml` that runs `aws ecs update-service` or
//      `aws deploy create-deployment` → lifted as deployProd on matching AWS targets.
func (h *FilesystemHandler) DetectDeploymentTargets(w http.ResponseWriter, r *http.Request) {
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

	resp := DetectDeploymentResponse{Signals: map[string]bool{}}

	// --- 1) Fly.toml ---------------------------------------------------------
	var flyTarget *DetectedTarget
	if data, err := os.ReadFile(filepath.Join(absPath, "fly.toml")); err == nil {
		if appName := parseFlyAppName(string(data)); appName != "" {
			resp.Signals["fly.toml"] = true
			flyTarget = &DetectedTarget{
				DeploymentConfig: models.DeploymentConfig{
					Name:        "fly-" + appName,
					Provider:    "flyio",
					FlyApp:      appName,
					DeployProd:  "fly deploy",
					StartProd:   "fly apps start " + appName,
					RestartProd: "fly apps restart " + appName,
					ViewLogs:    "fly logs -a " + appName,
				},
				Signals: []string{"fly.toml"},
			}
		}
	}

	// --- 2) ECS task-def artifacts (root + common nested dirs) ---------------
	taskDefPaths := collectTaskDefFiles(absPath)
	if len(taskDefPaths) > 0 {
		resp.Signals["ecs-taskdef"] = true
	}

	// --- 3) config/*.yaml envs -----------------------------------------------
	configEnvs := collectConfigEnvs(absPath)
	if len(configEnvs) > 0 {
		resp.Signals["config-envs"] = true
	}

	// --- Build AWS targets — one per config env, paired with a task-def
	// when we can find a filename match; otherwise use the first task-def
	// as the shared template. ------------------------------------------------
	awsTargets := buildAWSTargets(configEnvs, taskDefPaths)

	// --- 4) deploy.sh / start.sh / stop.sh -----------------------------------
	deployShFound := fileExists(filepath.Join(absPath, "deploy.sh"))
	startShFound := fileExists(filepath.Join(absPath, "start.sh"))
	stopShFound := fileExists(filepath.Join(absPath, "stop.sh"))
	if deployShFound {
		resp.Signals["deploy.sh"] = true
	}
	if startShFound {
		resp.Signals["start.sh"] = true
	}
	if stopShFound {
		resp.Signals["stop.sh"] = true
	}

	// --- 5) aws.md docs pointer ---------------------------------------------
	for _, name := range []string{"aws.md", "AWS.md", filepath.Join("docs", "aws.md"), filepath.Join("docs", "AWS.md")} {
		if fileExists(filepath.Join(absPath, name)) {
			resp.AWSDocPath = name
			break
		}
	}

	// --- 6) GH workflow ECS deploy commands ---------------------------------
	if awsCmd := findWorkflowECSDeployCommand(absPath); awsCmd != "" {
		resp.Signals["gh-workflow-ecs"] = true
		for i := range awsTargets {
			if awsTargets[i].DeployProd == "" {
				awsTargets[i].DeployProd = awsCmd
				awsTargets[i].Signals = append(awsTargets[i].Signals, ".github/workflows")
			}
		}
	}

	// --- Merge into final target list ---------------------------------------
	// Attach shell scripts (dev commands) to whichever target is the default.
	// For projects with no AWS targets, the Fly target (or a synthetic
	// "default" target) becomes default.
	var targets []DetectedTarget
	targets = append(targets, awsTargets...)
	if flyTarget != nil {
		// If AWS targets exist, treat Fly as legacy.
		if len(awsTargets) > 0 {
			flyTarget.IsLegacy = true
		}
		targets = append(targets, *flyTarget)
	}

	// If there's neither fly.toml nor ECS artifacts but shell scripts exist,
	// still surface a "default" target so the UI can render the commands.
	if len(targets) == 0 && (deployShFound || startShFound || stopShFound) {
		targets = append(targets, DetectedTarget{
			DeploymentConfig: models.DeploymentConfig{Name: "default"},
			Signals:          []string{},
		})
	}

	// Populate shell-script fields on the default-eligible target.
	defaultIdx := pickDefaultIndex(targets)
	if defaultIdx >= 0 {
		if deployShFound && targets[defaultIdx].DeployProd == "" {
			targets[defaultIdx].DeployProd = "./deploy.sh"
			targets[defaultIdx].Signals = append(targets[defaultIdx].Signals, "deploy.sh")
		}
		if startShFound && targets[defaultIdx].StartDev == "" {
			targets[defaultIdx].StartDev = "./start.sh"
			targets[defaultIdx].Signals = append(targets[defaultIdx].Signals, "start.sh")
		}
		if stopShFound && targets[defaultIdx].StopDev == "" {
			targets[defaultIdx].StopDev = "./stop.sh"
			targets[defaultIdx].Signals = append(targets[defaultIdx].Signals, "stop.sh")
		}
		targets[defaultIdx].IsDefault = true
	}

	resp.Targets = targets
	middleware.WriteJSON(w, http.StatusOK, resp)
}

// pickDefaultIndex returns the index of the first non-legacy target, or the
// first target if all are legacy, or -1 if none exist. When there's a "prod"
// AWS target we prefer that as default.
func pickDefaultIndex(targets []DetectedTarget) int {
	if len(targets) == 0 {
		return -1
	}
	// Prefer an AWS prod target.
	for i, t := range targets {
		if t.Provider == "aws" && !t.IsLegacy && strings.Contains(strings.ToLower(t.Name), "prod") {
			return i
		}
	}
	// Otherwise first non-legacy.
	for i, t := range targets {
		if !t.IsLegacy {
			return i
		}
	}
	return 0
}

func parseFlyAppName(data string) string {
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "app") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		return strings.Trim(strings.TrimSpace(parts[1]), `"'`)
	}
	return ""
}

// collectTaskDefFiles returns repo-relative paths of files that look like ECS
// task definitions. We look in the conventional locations rather than doing
// a full-tree scan (which would be too slow on large repos).
func collectTaskDefFiles(root string) []string {
	var out []string
	seen := map[string]bool{}

	// Root-level task-definition*.json / taskdef*.json.
	rootEntries, _ := os.ReadDir(root)
	for _, e := range rootEntries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		lower := strings.ToLower(name)
		if (strings.HasPrefix(lower, "task-definition") || strings.HasPrefix(lower, "taskdef")) &&
			strings.HasSuffix(lower, ".json") {
			if !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
	}

	// Nested conventional dirs.
	for _, dir := range []string{
		filepath.Join("build", "ecs"),
		filepath.Join("deploy", "ecs"),
		filepath.Join(".aws", "ecs"),
	} {
		abs := filepath.Join(root, dir)
		entries, err := os.ReadDir(abs)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			lower := strings.ToLower(name)
			// Accept .json and .json.liquid (templated task defs).
			if strings.HasSuffix(lower, ".json") || strings.HasSuffix(lower, ".json.liquid") {
				rel := filepath.Join(dir, name)
				if !seen[rel] {
					seen[rel] = true
					out = append(out, rel)
				}
			}
		}
	}

	sort.Strings(out)
	return out
}

// configEnv identifies a candidate environment from a config/<name>.yaml file.
type configEnv struct {
	Name string // e.g. "prod"
	Path string // repo-relative path, e.g. "config/prod.yaml"
}

// collectConfigEnvs scans config/*.yaml and returns one entry per env, skipping
// obvious non-envs (local, example, fly-*).
func collectConfigEnvs(root string) []configEnv {
	dir := filepath.Join(root, "config")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []configEnv
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		lower := strings.ToLower(name)
		if !strings.HasSuffix(lower, ".yaml") && !strings.HasSuffix(lower, ".yml") {
			continue
		}
		base := strings.TrimSuffix(strings.TrimSuffix(name, ".yaml"), ".yml")
		lowerBase := strings.ToLower(base)
		// Skip machine-local or clearly non-deployment configs.
		if lowerBase == "local" || lowerBase == "example" || strings.HasPrefix(lowerBase, "fly") {
			continue
		}
		out = append(out, configEnv{
			Name: base,
			Path: filepath.Join("config", name),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// secondaryTaskDefKeywords marks task-def files that are almost never the
// primary service definition — sandbox/VM/lambda side concerns, adjacent
// runtimes, etc. When pairing config envs with a task-def, we deprioritise
// these so we don't misattribute the main service's env to a sidecar.
var secondaryTaskDefKeywords = []string{"sandbox", "vm", "microvm", "lambda", "sidecar", "worker"}

// isSecondaryTaskDef returns true if the given path's basename matches any of
// the secondary keywords (case-insensitive).
func isSecondaryTaskDef(path string) bool {
	lower := strings.ToLower(path)
	for _, kw := range secondaryTaskDefKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// buildAWSTargets pairs config envs with a task-def file (best-effort filename
// match) and returns one target per env. If no config envs were detected but
// task-defs exist, returns a single "aws" target using the first primary task-def.
func buildAWSTargets(envs []configEnv, taskDefs []string) []DetectedTarget {
	// Split into primary vs secondary so the fallback picks the main one.
	var primary, secondary []string
	for _, td := range taskDefs {
		if isSecondaryTaskDef(td) {
			secondary = append(secondary, td)
		} else {
			primary = append(primary, td)
		}
	}
	// Prefer primary as the fallback pool; only fall back to secondary if
	// nothing else is available.
	fallbackPool := primary
	if len(fallbackPool) == 0 {
		fallbackPool = secondary
	}

	if len(envs) == 0 {
		if len(fallbackPool) == 0 {
			return nil
		}
		return []DetectedTarget{{
			DeploymentConfig: models.DeploymentConfig{
				Name:     "aws",
				Provider: "aws",
				TaskDef:  fallbackPool[0],
			},
			Signals: []string{fallbackPool[0]},
		}}
	}
	var out []DetectedTarget
	for _, env := range envs {
		// Best-effort: pick a task-def whose filename mentions the env AND
		// isn't a secondary (sandbox/VM/etc). If nothing matches by name,
		// fall back to the primary pool.
		taskDef := ""
		for _, td := range primary {
			if strings.Contains(strings.ToLower(td), strings.ToLower(env.Name)) {
				taskDef = td
				break
			}
		}
		if taskDef == "" && len(fallbackPool) > 0 {
			taskDef = fallbackPool[0]
		}
		signals := []string{env.Path}
		if taskDef != "" {
			signals = append(signals, taskDef)
		}
		out = append(out, DetectedTarget{
			DeploymentConfig: models.DeploymentConfig{
				Name:       "aws-" + env.Name,
				Provider:   "aws",
				ConfigFile: env.Path,
				TaskDef:    taskDef,
			},
			Signals: signals,
		})
	}
	return out
}

// findWorkflowECSDeployCommand scans .github/workflows/*.yml for the first line
// that looks like an actual `aws ecs update-service` or `aws deploy create-deployment`
// invocation, and returns it trimmed. Best-effort — the user can edit after.
func findWorkflowECSDeployCommand(root string) string {
	dir := filepath.Join(root, ".github", "workflows")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		lower := strings.ToLower(e.Name())
		if !strings.HasSuffix(lower, ".yml") && !strings.HasSuffix(lower, ".yaml") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			trimmed := strings.TrimLeft(line, " \t-")
			lower := strings.ToLower(trimmed)
			if strings.HasPrefix(lower, "aws ecs update-service") ||
				strings.HasPrefix(lower, "aws deploy create-deployment") {
				return trimmed
			}
		}
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// Compile-time assertion — avoids drift if the shared JSON encoder changes.
var _ = json.Marshal
var _ = fmt.Sprintf
