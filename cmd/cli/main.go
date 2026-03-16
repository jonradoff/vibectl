package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"
)

var baseURL string
var formatJSON bool
var authToken string

func init() {
	baseURL = os.Getenv("VIBECTL_URL")
	if baseURL == "" {
		baseURL = "http://localhost:4380"
	}
	baseURL = strings.TrimRight(baseURL, "/")

	// Load auth token: env var takes priority, then ~/.vibectl/token file.
	authToken = os.Getenv("VIBECTL_TOKEN")
	if authToken == "" {
		if data, err := os.ReadFile(tokenFilePath()); err == nil {
			authToken = strings.TrimSpace(string(data))
		}
	}
}

func tokenFilePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".vibectl", "token")
}

func saveToken(token string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".vibectl")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "token"), []byte(token+"\n"), 0600)
}

func main() {
	// Parse global --format flag from os.Args before subcommand parsing.
	args := os.Args[1:]
	var cleaned []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--format" && i+1 < len(args) {
			if args[i+1] == "json" {
				formatJSON = true
			}
			i++
			continue
		}
		if strings.HasPrefix(args[i], "--format=") {
			if strings.TrimPrefix(args[i], "--format=") == "json" {
				formatJSON = true
			}
			continue
		}
		cleaned = append(cleaned, args[i])
	}
	args = cleaned

	if len(args) < 1 {
		usage()
		os.Exit(1)
	}

	switch args[0] {
	case "projects":
		cmdProjects(args[1:])
	case "issues":
		cmdIssues(args[1:])
	case "feedback":
		cmdFeedback(args[1:])
	case "dashboard":
		cmdDashboard(args[1:])
	case "generate-md":
		cmdGenerateMd(args[1:])
	case "decisions":
		cmdDecisions(args[1:])
	case "health":
		cmdHealth(args[1:])
	case "sessions":
		cmdSessions(args[1:])
	case "prompts":
		cmdPrompts(args[1:])
	case "admin":
		cmdAdmin(args[1:])
	case "help", "--help", "-h":
		usage()
	default:
		fatalf("unknown command: %s\n", args[0])
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `Usage: vibectl <command> <action> [flags]

Commands:
  projects list
  projects create    --name NAME --code CODE [--local-path PATH] [--github-url URL] [--description DESC]

  issues list        CODE [--priority P0] [--status open] [--type bug]
  issues create      CODE --title TITLE --type TYPE --priority PRI [--description DESC] [--repro-steps STEPS] [--source SRC] [--created-by USER]
  issues view        ISSUE-KEY
  issues status      ISSUE-KEY NEW_STATUS
  issues search      "query text"

  feedback submit    CODE --content "text" [--source-type manual] [--submitted-by NAME]
  feedback triage    --pending

  health             CODE                Check current health status for a project
  health history     CODE                Show uptime history (last 24h) for a project

  sessions           CODE [--limit N]    List work sessions for a project

  prompts list       [CODE]              List prompts (project + global, or global only)
  prompts get        PROMPT-ID           Show prompt body

  dashboard

  generate-md    CODE               Generate VIBECTL.md for a project
  generate-md    --all              Generate VIBECTL.md for all projects

  decisions      CODE [--limit N]   List recent decisions for a project

  admin login                       Authenticate with server password, save token
  admin set-password                Set or change the admin password
  admin logout                      Remove saved auth token

Global flags:
  --format json      Output raw JSON instead of human-readable format

Environment:
  VIBECTL_URL        Base URL of VibeCtl server (default: http://localhost:4380)
  VIBECTL_TOKEN      Bearer token (overrides ~/.vibectl/token)`)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func doGet(path string) ([]byte, error) {
	req, err := http.NewRequest("GET", baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	addAuth(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}
	return body, nil
}

func doPost(path string, payload interface{}) ([]byte, error) {
	return doRequest("POST", path, payload)
}

func doPut(path string, payload interface{}) ([]byte, error) {
	return doRequest("PUT", path, payload)
}

func doPatch(path string, payload interface{}) ([]byte, error) {
	return doRequest("PATCH", path, payload)
}

func doDelete(path string) error {
	req, err := http.NewRequest("DELETE", baseURL+path, nil)
	if err != nil {
		return err
	}
	addAuth(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func doRequest(method, path string, payload interface{}) ([]byte, error) {
	var buf bytes.Buffer
	if payload != nil {
		if err := json.NewEncoder(&buf).Encode(payload); err != nil {
			return nil, fmt.Errorf("encoding body: %w", err)
		}
	}
	req, err := http.NewRequest(method, baseURL+path, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	addAuth(req)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}
	return body, nil
}

func addAuth(req *http.Request) {
	if authToken != "" {
		req.Header.Set("Authorization", "Bearer "+authToken)
	}
}

// lookupProjectID resolves a project code to its ObjectID hex string.
func lookupProjectID(code string) (string, error) {
	data, err := doGet("/api/v1/projects/code/" + url.PathEscape(code))
	if err != nil {
		return "", fmt.Errorf("project %q not found: %w", code, err)
	}
	var proj map[string]interface{}
	if err := json.Unmarshal(data, &proj); err != nil {
		return "", err
	}
	id, ok := proj["id"].(string)
	if !ok {
		return "", fmt.Errorf("project response missing id")
	}
	return id, nil
}

func fatalf(format string, a ...interface{}) {
	fmt.Fprintf(os.Stderr, "Error: "+format, a...)
	os.Exit(1)
}

func printRawJSON(data []byte) {
	var buf bytes.Buffer
	if json.Indent(&buf, data, "", "  ") == nil {
		fmt.Println(buf.String())
	} else {
		fmt.Println(string(data))
	}
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

func cmdProjects(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl projects <list|create>\n")
	}
	switch args[0] {
	case "list":
		projectsList()
	case "create":
		projectsCreate(args[1:])
	default:
		fatalf("unknown projects action: %s\n", args[0])
	}
}

func projectsList() {
	data, err := doGet("/api/v1/projects")
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}

	var projects []map[string]interface{}
	if err := json.Unmarshal(data, &projects); err != nil {
		fatalf("parsing response: %v\n", err)
	}

	if len(projects) == 0 {
		fmt.Println("No projects found.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "CODE\tNAME\tDESCRIPTION\tCREATED")
	for _, p := range projects {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
			str(p, "code"), str(p, "name"),
			truncate(str(p, "description"), 40),
			formatTime(str(p, "createdAt")))
	}
	w.Flush()
}

func projectsCreate(args []string) {
	fs := flag.NewFlagSet("projects create", flag.ExitOnError)
	name := fs.String("name", "", "Project name (required)")
	code := fs.String("code", "", "Project code (required)")
	desc := fs.String("description", "", "Project description")
	localPath := fs.String("local-path", "", "Local filesystem path")
	githubURL := fs.String("github-url", "", "GitHub repository URL")
	fs.Parse(args)

	if *name == "" || *code == "" {
		fatalf("--name and --code are required\n")
	}

	body := map[string]interface{}{
		"name": *name, "code": *code, "description": *desc,
		"links": map[string]interface{}{"localPath": *localPath, "githubUrl": *githubURL},
		"goals": []string{},
	}

	data, err := doPost("/api/v1/projects", body)
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var proj map[string]interface{}
	json.Unmarshal(data, &proj)
	fmt.Printf("Project created: %s (%s)\n", str(proj, "name"), str(proj, "code"))
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

func cmdIssues(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl issues <list|create|view|status|search>\n")
	}
	switch args[0] {
	case "list":
		issuesList(args[1:])
	case "create":
		issuesCreate(args[1:])
	case "view":
		issuesView(args[1:])
	case "status":
		issuesStatus(args[1:])
	case "search":
		issuesSearch(args[1:])
	default:
		fatalf("unknown issues action: %s\n", args[0])
	}
}

func issuesList(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl issues list CODE [--priority P0] [--status open] [--type bug]\n")
	}
	code := args[0]
	fs := flag.NewFlagSet("issues list", flag.ExitOnError)
	priority := fs.String("priority", "", "Filter by priority")
	status := fs.String("status", "", "Filter by status")
	issueType := fs.String("type", "", "Filter by type")
	fs.Parse(args[1:])

	projectID, err := lookupProjectID(code)
	if err != nil {
		fatalf("%v\n", err)
	}

	path := fmt.Sprintf("/api/v1/projects/%s/issues", projectID)
	params := url.Values{}
	if *priority != "" { params.Set("priority", *priority) }
	if *status != "" { params.Set("status", *status) }
	if *issueType != "" { params.Set("type", *issueType) }
	if len(params) > 0 { path += "?" + params.Encode() }

	data, err := doGet(path)
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}

	var issues []map[string]interface{}
	if err := json.Unmarshal(data, &issues); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(issues) == 0 {
		fmt.Println("No issues found.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "KEY\tTYPE\tPRIORITY\tSTATUS\tTITLE")
	for _, iss := range issues {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			str(iss, "issueKey"), str(iss, "type"), str(iss, "priority"),
			str(iss, "status"), truncate(str(iss, "title"), 50))
	}
	w.Flush()
}

func issuesCreate(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl issues create CODE --title TITLE --type TYPE --priority PRI ...\n")
	}
	code := args[0]
	fs := flag.NewFlagSet("issues create", flag.ExitOnError)
	title := fs.String("title", "", "Issue title (required)")
	issueType := fs.String("type", "", "Issue type: bug, feature, idea (required)")
	priority := fs.String("priority", "", "Priority: P0-P5 (required)")
	desc := fs.String("description", "", "Issue description")
	reproSteps := fs.String("repro-steps", "", "Reproduction steps (required for bugs)")
	source := fs.String("source", "", "Source of the issue")
	createdBy := fs.String("created-by", "", "Who created the issue")
	fs.Parse(args[1:])

	if *title == "" || *issueType == "" || *priority == "" {
		fatalf("--title, --type, and --priority are required\n")
	}

	projectID, err := lookupProjectID(code)
	if err != nil {
		fatalf("%v\n", err)
	}

	body := map[string]interface{}{"title": *title, "type": *issueType, "priority": *priority}
	if *desc != "" { body["description"] = *desc }
	if *reproSteps != "" { body["reproSteps"] = *reproSteps }
	if *source != "" { body["source"] = *source }
	if *createdBy != "" { body["createdBy"] = *createdBy }

	data, err := doPost(fmt.Sprintf("/api/v1/projects/%s/issues", projectID), body)
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var iss map[string]interface{}
	json.Unmarshal(data, &iss)
	fmt.Printf("Issue created: %s  %s [%s/%s]\n",
		str(iss, "issueKey"), str(iss, "title"), str(iss, "type"), str(iss, "priority"))
}

func issuesView(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl issues view ISSUE-KEY\n")
	}
	data, err := doGet("/api/v1/issues/" + url.PathEscape(args[0]))
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var iss map[string]interface{}
	json.Unmarshal(data, &iss)
	fmt.Printf("Issue:       %s\n", str(iss, "issueKey"))
	fmt.Printf("Title:       %s\n", str(iss, "title"))
	fmt.Printf("Type:        %s\n", str(iss, "type"))
	fmt.Printf("Priority:    %s\n", str(iss, "priority"))
	fmt.Printf("Status:      %s\n", str(iss, "status"))
	if v := str(iss, "description"); v != "" { fmt.Printf("Description: %s\n", v) }
	if v := str(iss, "reproSteps"); v != "" { fmt.Printf("Repro Steps: %s\n", v) }
	if v := str(iss, "source"); v != "" { fmt.Printf("Source:      %s\n", v) }
	if v := str(iss, "createdBy"); v != "" { fmt.Printf("Created By:  %s\n", v) }
	fmt.Printf("Created:     %s\n", formatTime(str(iss, "createdAt")))
	fmt.Printf("Updated:     %s\n", formatTime(str(iss, "updatedAt")))
}

func issuesStatus(args []string) {
	if len(args) < 2 {
		fatalf("usage: vibectl issues status ISSUE-KEY NEW_STATUS\n")
	}
	data, err := doPatch("/api/v1/issues/"+url.PathEscape(args[0])+"/status", map[string]string{"status": args[1]})
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var iss map[string]interface{}
	json.Unmarshal(data, &iss)
	fmt.Printf("Status updated: %s -> %s\n", str(iss, "issueKey"), str(iss, "status"))
}

func issuesSearch(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl issues search \"query text\"\n")
	}
	data, err := doGet("/api/v1/issues/search?q=" + url.QueryEscape(strings.Join(args, " ")))
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var issues []map[string]interface{}
	if err := json.Unmarshal(data, &issues); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(issues) == 0 {
		fmt.Println("No issues found.")
		return
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "KEY\tTYPE\tPRIORITY\tSTATUS\tTITLE")
	for _, iss := range issues {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			str(iss, "issueKey"), str(iss, "type"), str(iss, "priority"),
			str(iss, "status"), truncate(str(iss, "title"), 50))
	}
	w.Flush()
}

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

func cmdFeedback(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl feedback <submit|triage>\n")
	}
	switch args[0] {
	case "submit":
		feedbackSubmit(args[1:])
	case "triage":
		feedbackTriage(args[1:])
	default:
		fatalf("unknown feedback action: %s\n", args[0])
	}
}

func feedbackSubmit(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl feedback submit CODE --content \"text\" [--source-type manual] [--submitted-by NAME]\n")
	}
	code := args[0]
	fs := flag.NewFlagSet("feedback submit", flag.ExitOnError)
	content := fs.String("content", "", "Feedback content (required)")
	sourceType := fs.String("source-type", "manual", "Source type")
	submittedBy := fs.String("submitted-by", "", "Name of submitter")
	fs.Parse(args[1:])

	if *content == "" {
		fatalf("--content is required\n")
	}
	projectID, err := lookupProjectID(code)
	if err != nil {
		fatalf("%v\n", err)
	}
	body := map[string]interface{}{"projectId": projectID, "rawContent": *content, "sourceType": *sourceType}
	if *submittedBy != "" { body["submittedBy"] = *submittedBy }

	data, err := doPost("/api/v1/feedback", body)
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var fb map[string]interface{}
	json.Unmarshal(data, &fb)
	fmt.Printf("Feedback submitted (id: %s, status: %s)\n", str(fb, "id"), str(fb, "triageStatus"))
}

func feedbackTriage(args []string) {
	fs := flag.NewFlagSet("feedback triage", flag.ExitOnError)
	pending := fs.Bool("pending", false, "Show pending feedback only")
	fs.Parse(args)

	path := "/api/v1/feedback"
	if *pending { path += "?triageStatus=pending" }

	data, err := doGet(path)
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var items []map[string]interface{}
	if err := json.Unmarshal(data, &items); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(items) == 0 {
		fmt.Println("No feedback items found.")
		return
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tSOURCE\tSTATUS\tSUBMITTED\tCONTENT")
	for _, fb := range items {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			str(fb, "id"), str(fb, "sourceType"), str(fb, "triageStatus"),
			formatTime(str(fb, "submittedAt")), truncate(str(fb, "rawContent"), 50))
	}
	w.Flush()
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

func cmdDashboard(_ []string) {
	data, err := doGet("/api/v1/dashboard")
	if err != nil {
		fatalf("%v\n", err)
	}
	if formatJSON {
		printRawJSON(data)
		return
	}
	var dash map[string]interface{}
	if err := json.Unmarshal(data, &dash); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	fmt.Printf("=== VibeCtl Dashboard ===\n\n")
	fmt.Printf("Total Projects:    %.0f\n", num(dash, "totalProjects"))
	fmt.Printf("Total Open Issues: %.0f\n", num(dash, "totalOpenIssues"))
	fmt.Printf("Pending Feedback:  %.0f\n\n", num(dash, "pendingFeedback"))

	summaries, _ := dash["projectSummaries"].([]interface{})
	for _, s := range summaries {
		sm, ok := s.(map[string]interface{})
		if !ok { continue }
		proj, _ := sm["project"].(map[string]interface{})
		fmt.Printf("--- %s (%s) ---\n", str(proj, "name"), str(proj, "code"))
		fmt.Printf("  Open Issues: %d\n", int(num(sm, "openIssueCount")))
		if byPri, ok := sm["issuesByPriority"].(map[string]interface{}); ok && len(byPri) > 0 {
			parts := []string{}
			for k, v := range byPri { parts = append(parts, fmt.Sprintf("%s=%v", k, v)) }
			fmt.Println("  By Priority: " + strings.Join(parts, ", "))
		}
		if byStatus, ok := sm["issuesByStatus"].(map[string]interface{}); ok && len(byStatus) > 0 {
			parts := []string{}
			for k, v := range byStatus { parts = append(parts, fmt.Sprintf("%s=%v", k, v)) }
			fmt.Println("  By Status:   " + strings.Join(parts, ", "))
		}
		fmt.Println()
	}
}

// ---------------------------------------------------------------------------
// generate-md
// ---------------------------------------------------------------------------

func cmdGenerateMd(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl generate-md CODE  or  vibectl generate-md --all\n")
	}
	if args[0] == "--all" {
		data, err := doGet("/api/v1/projects")
		if err != nil { fatalf("%v\n", err) }
		var projects []map[string]interface{}
		json.Unmarshal(data, &projects)
		count := 0
		for _, p := range projects {
			if _, err := doPost(fmt.Sprintf("/api/v1/projects/%s/vibectl-md/generate", str(p, "id")), nil); err != nil {
				fmt.Fprintf(os.Stderr, "  %s: %v\n", str(p, "code"), err)
				continue
			}
			fmt.Printf("  %s: generated\n", str(p, "code"))
			count++
		}
		fmt.Printf("\nGenerated VIBECTL.md for %d project(s).\n", count)
		return
	}
	code := args[0]
	projectID, err := lookupProjectID(code)
	if err != nil { fatalf("%v\n", err) }
	if _, err := doPost(fmt.Sprintf("/api/v1/projects/%s/vibectl-md/generate", projectID), nil); err != nil {
		fatalf("%v\n", err)
	}
	fmt.Printf("VIBECTL.md generated for %s.\n", code)
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

func cmdDecisions(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl decisions CODE [--limit N]\n")
	}
	code := args[0]
	fs := flag.NewFlagSet("decisions", flag.ExitOnError)
	limit := fs.Int("limit", 20, "Number of decisions to show")
	fs.Parse(args[1:])

	projectID, err := lookupProjectID(code)
	if err != nil { fatalf("%v\n", err) }

	data, err := doGet(fmt.Sprintf("/api/v1/projects/%s/decisions?limit=%d", projectID, *limit))
	if err != nil { fatalf("%v\n", err) }
	if formatJSON {
		printRawJSON(data)
		return
	}
	var decisions []map[string]interface{}
	if err := json.Unmarshal(data, &decisions); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(decisions) == 0 {
		fmt.Println("No decisions recorded.")
		return
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "DATE\tACTION\tISSUE\tSUMMARY")
	for _, d := range decisions {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
			formatTime(str(d, "timestamp")), str(d, "action"),
			str(d, "issueKey"), truncate(str(d, "summary"), 60))
	}
	w.Flush()
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

func cmdHealth(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl health CODE\n       vibectl health history CODE\n")
	}
	if args[0] == "history" {
		if len(args) < 2 { fatalf("usage: vibectl health history CODE\n") }
		healthHistory(args[1])
		return
	}
	healthCheck(args[0])
}

func healthCheck(code string) {
	projectID, err := lookupProjectID(code)
	if err != nil { fatalf("%v\n", err) }

	data, err := doGet(fmt.Sprintf("/api/v1/projects/%s/healthcheck", projectID))
	if err != nil { fatalf("%v\n", err) }
	if formatJSON {
		printRawJSON(data)
		return
	}
	var results []map[string]interface{}
	if err := json.Unmarshal(data, &results); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(results) == 0 {
		fmt.Println("No health check endpoints configured.")
		return
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ENDPOINT\tSTATUS\tCODE\tURL\tNOTE")
	for _, r := range results {
		status := str(r, "status")
		icon := map[string]string{"up": "✓", "down": "✗", "degraded": "⚠"}[status]
		if icon == "" { icon = "?" }
		note := str(r, "error")
		if v := str(r, "version"); v != "" { note = "v" + v }
		fmt.Fprintf(w, "%s\t%s %s\t%.0f\t%s\t%s\n",
			str(r, "name"), icon, status, num(r, "code"),
			str(r, "url"), truncate(note, 40))
	}
	w.Flush()
}

func healthHistory(code string) {
	projectID, err := lookupProjectID(code)
	if err != nil { fatalf("%v\n", err) }

	data, err := doGet(fmt.Sprintf("/api/v1/projects/%s/healthcheck/history", projectID))
	if err != nil { fatalf("%v\n", err) }
	if formatJSON {
		printRawJSON(data)
		return
	}
	var records []map[string]interface{}
	if err := json.Unmarshal(data, &records); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(records) == 0 {
		fmt.Println("No health history recorded.")
		return
	}
	fmt.Printf("Health history for %s (%d records):\n\n", code, len(records))
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "TIME\tFRONTEND\tBACKEND")
	for _, rec := range records {
		ts := formatTime(str(rec, "checkedAt"))
		results, _ := rec["results"].([]interface{})
		front, back := "-", "-"
		for _, res := range results {
			r, ok := res.(map[string]interface{})
			if !ok { continue }
			switch str(r, "name") {
			case "Frontend": front = str(r, "status")
			case "Backend": back = str(r, "status")
			}
		}
		fmt.Fprintf(w, "%s\t%s\t%s\n", ts, front, back)
	}
	w.Flush()
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

func cmdSessions(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl sessions CODE [--limit N]\n")
	}
	code := args[0]
	fs := flag.NewFlagSet("sessions", flag.ExitOnError)
	limit := fs.Int("limit", 10, "Number of sessions to show")
	fs.Parse(args[1:])

	projectID, err := lookupProjectID(code)
	if err != nil { fatalf("%v\n", err) }

	data, err := doGet(fmt.Sprintf("/api/v1/projects/%s/sessions", projectID))
	if err != nil { fatalf("%v\n", err) }
	if formatJSON {
		printRawJSON(data)
		return
	}
	var sessions []map[string]interface{}
	if err := json.Unmarshal(data, &sessions); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(sessions) == 0 {
		fmt.Println("No sessions recorded.")
		return
	}
	if *limit > 0 && len(sessions) > *limit {
		sessions = sessions[:*limit]
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "STARTED\tSTATUS\tSUMMARY")
	for _, s := range sessions {
		summary := str(s, "summary")
		if summary == "" { summary = "(no summary)" }
		fmt.Fprintf(w, "%s\t%s\t%s\n",
			formatTime(str(s, "startedAt")), str(s, "status"), truncate(summary, 60))
	}
	w.Flush()
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

func cmdPrompts(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl prompts <list|get>\n")
	}
	switch args[0] {
	case "list":
		promptsList(args[1:])
	case "get":
		promptsGet(args[1:])
	default:
		fatalf("unknown prompts action: %s\n", args[0])
	}
}

func promptsList(args []string) {
	var path string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		projectID, err := lookupProjectID(args[0])
		if err != nil { fatalf("%v\n", err) }
		path = fmt.Sprintf("/api/v1/projects/%s/prompts", projectID)
	} else {
		path = "/api/v1/prompts"
	}
	data, err := doGet(path)
	if err != nil { fatalf("%v\n", err) }
	if formatJSON {
		printRawJSON(data)
		return
	}
	var prompts []map[string]interface{}
	if err := json.Unmarshal(data, &prompts); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	if len(prompts) == 0 {
		fmt.Println("No prompts found.")
		return
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tGLOBAL\tNAME\tUPDATED")
	for _, p := range prompts {
		global := "no"
		if g, ok := p["global"].(bool); ok && g { global = "yes" }
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
			str(p, "id"), global, str(p, "name"), formatTime(str(p, "updatedAt")))
	}
	w.Flush()
}

func promptsGet(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl prompts get PROMPT-ID\n")
	}
	data, err := doGet("/api/v1/prompts/" + url.PathEscape(args[0]))
	if err != nil { fatalf("%v\n", err) }
	if formatJSON {
		printRawJSON(data)
		return
	}
	var p map[string]interface{}
	json.Unmarshal(data, &p)
	global := "no"
	if g, ok := p["global"].(bool); ok && g { global = "yes" }
	fmt.Printf("Name:    %s\n", str(p, "name"))
	fmt.Printf("Global:  %s\n", global)
	fmt.Printf("Updated: %s\n\n", formatTime(str(p, "updatedAt")))
	fmt.Println(str(p, "body"))
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

func cmdAdmin(args []string) {
	if len(args) < 1 {
		fatalf("usage: vibectl admin <login|set-password|logout>\n")
	}
	switch args[0] {
	case "login":
		adminLogin()
	case "set-password":
		adminSetPassword()
	case "logout":
		adminLogout()
	default:
		fatalf("unknown admin action: %s\n", args[0])
	}
}

func adminLogin() {
	fmt.Print("Password: ")
	password, _ := readPassword()
	if password == "" {
		fatalf("password cannot be empty\n")
	}

	data, err := doPost("/api/v1/admin/login", map[string]string{"password": password})
	if err != nil {
		fatalf("%v\n", err)
	}
	var resp map[string]string
	if err := json.Unmarshal(data, &resp); err != nil {
		fatalf("parsing response: %v\n", err)
	}
	token := resp["token"]
	if token == "" {
		fatalf("no token in response\n")
	}
	if err := saveToken(token); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not save token: %v\n", err)
	}
	authToken = token
	fmt.Printf("Logged in. Token saved to %s\n", tokenFilePath())
}

func adminSetPassword() {
	fmt.Print("Current password (leave blank if not yet set): ")
	current, _ := readPassword()

	fmt.Print("New password (min 8 chars): ")
	newPw, err := readPassword()
	if err != nil || newPw == "" {
		fatalf("new password cannot be empty\n")
	}
	if len(newPw) < 8 {
		fatalf("password must be at least 8 characters\n")
	}
	fmt.Print("Confirm new password: ")
	confirm, _ := readPassword()
	if confirm != newPw {
		fatalf("passwords do not match\n")
	}

	data, err := doPost("/api/v1/admin/set-password", map[string]string{
		"currentPassword": current,
		"newPassword":     newPw,
	})
	if err != nil {
		fatalf("%v\n", err)
	}
	var resp map[string]string
	json.Unmarshal(data, &resp)
	if token := resp["token"]; token != "" {
		if err := saveToken(token); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: could not save token: %v\n", err)
		} else {
			authToken = token
			fmt.Printf("Password updated. Token saved to %s\n", tokenFilePath())
			return
		}
	}
	fmt.Println("Password updated.")
}

func adminLogout() {
	path := tokenFilePath()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		fatalf("removing token: %v\n", err)
	}
	authToken = ""
	fmt.Println("Logged out. Token removed.")
}

// readPassword reads one line from stdin (no echo suppression — simple version).
func readPassword() (string, error) {
	var line string
	_, err := fmt.Scanln(&line)
	if err != nil && err.Error() == "unexpected newline" {
		return "", nil
	}
	return strings.TrimSpace(line), err
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

func str(m map[string]interface{}, key string) string {
	v, _ := m[key].(string)
	return v
}

func num(m map[string]interface{}, key string) float64 {
	v, _ := m[key].(float64)
	return v
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

func formatTime(s string) string {
	if s == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t2, err2 := time.Parse(time.RFC3339, s)
		if err2 != nil {
			return s
		}
		t = t2
	}
	return t.Local().Format("2006-01-02 15:04")
}
