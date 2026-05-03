package services

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jonradoff/vibectl/internal/models"
)

// VibectlMdService generates and writes VIBECTL.md files for projects.
type VibectlMdService struct {
	projects      *ProjectService
	issues        *IssueService
	feedback      *FeedbackService
	sessions      *SessionService
	decisions     *DecisionService
	healthRecords *HealthRecordService
	version       string
	writeMu       sync.Map // projectID string → *sync.Mutex
	// OnWrite is called after VIBECTL.md is successfully written, with (projectID, content).
	OnWrite func(projectID, content string)
}

func NewVibectlMdService(
	projects *ProjectService,
	issues *IssueService,
	feedback *FeedbackService,
	sessions *SessionService,
	decisions *DecisionService,
	healthRecords *HealthRecordService,
	version string,
) *VibectlMdService {
	return &VibectlMdService{
		projects:      projects,
		issues:        issues,
		feedback:      feedback,
		sessions:      sessions,
		decisions:     decisions,
		healthRecords: healthRecords,
		version:       version,
	}
}

func (s *VibectlMdService) projectMu(projectID string) *sync.Mutex {
	v, _ := s.writeMu.LoadOrStore(projectID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// Generate assembles the full VIBECTL.md content for a project.
func (s *VibectlMdService) Generate(ctx context.Context, projectID string) (string, error) {
	project, err := s.projects.GetByID(ctx, projectID)
	if err != nil || project == nil {
		project, err = s.projects.GetByCode(ctx, projectID)
	}
	if err != nil || project == nil {
		return "", fmt.Errorf("get project: project not found")
	}

	now := time.Now().UTC()

	// Fetch open issues
	allIssues, _ := s.issues.ListByProject(ctx, project.Code, nil)
	openIssues := filterOpenIssues(allIssues)

	// Counts
	priorityCounts, _ := s.issues.CountByPriority(ctx, project.Code)
	typeCounts := countIssuesByType(openIssues)

	// Recent decisions
	decisions, _ := s.decisions.ListRecent(ctx, project.Code, 20)

	// Latest session
	latestSession, _ := s.sessions.GetLatest(ctx, project.Code)

	// Read existing notes section
	existingNotes := "_Add your own notes here. This section is preserved across regenerations._"
	if project.Links.LocalPath != "" {
		if existing, readErr := os.ReadFile(filepath.Join(project.Links.LocalPath, "VIBECTL.md")); readErr == nil {
			sections := parseExistingSections(string(existing))
			if n, ok := sections["notes"]; ok && strings.TrimSpace(n) != "" {
				existingNotes = n
			}
		}
	}

	var b strings.Builder

	// Header
	fmt.Fprintf(&b, "<!-- VIBECTL.md — Auto-maintained by VibeCtl v%s. Last generated: %s -->\n", s.version, now.Format(time.RFC3339))
	b.WriteString("<!-- Manual edits in the [Notes] section are preserved. Other sections may be regenerated. -->\n\n")
	fmt.Fprintf(&b, "# %s (%s)\n\n", project.Name, project.Code)

	// Meta
	b.WriteString("## Meta\n")
	fmt.Fprintf(&b, "- **VibeCtl Version:** %s\n", s.version)
	fmt.Fprintf(&b, "- **Generated:** %s\n", now.Format(time.RFC3339))
	fmt.Fprintf(&b, "- **Project ID:** %s\n", project.ID.Hex())
	fmt.Fprintf(&b, "- **Local Path:** %s\n", project.Links.LocalPath)
	gh := project.Links.GitHubURL
	if gh == "" {
		gh = "N/A"
	}
	fmt.Fprintf(&b, "- **GitHub:** %s\n\n", gh)

	writeSection(&b, "Status", "status", s.genStatus(openIssues, priorityCounts, typeCounts, latestSession))
	writeSection(&b, "Active Focus", "focus", s.genFocus(openIssues))
	writeSection(&b, "Goals", "goals", s.genGoals(project))
	writeSection(&b, "Deployment", "deployment", s.genDeployment(project))
	writeSection(&b, "Recent Decisions", "decisions", s.genDecisions(decisions))
	pendingFeedback, _ := s.feedback.ListByProject(ctx, project.Code)
	writeSection(&b, "Pending Feedback", "feedback", genPendingFeedback(pendingFeedback))
	writeSection(&b, "Recurring Themes", "themes", s.genThemes(project))
	writeSection(&b, "Architecture", "architecture", s.genArchitecture(project))

	// Notes (preserved)
	b.WriteString("## Notes\n")
	b.WriteString("<!-- vibectl:section:notes -->\n")
	b.WriteString(existingNotes)
	if !strings.HasSuffix(existingNotes, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("<!-- vibectl:end:notes -->\n")

	return b.String(), nil
}

// WriteToProject generates VIBECTL.md and writes it to the project's localPath.
func (s *VibectlMdService) WriteToProject(ctx context.Context, projectID string) error {
	project, err := s.projects.GetByID(ctx, projectID)
	if err != nil || project == nil {
		project, err = s.projects.GetByCode(ctx, projectID)
	}
	if err != nil || project == nil {
		return fmt.Errorf("get project: project not found")
	}
	localPath := project.Links.LocalPath
	if localPath == "" {
		return nil
	}
	if _, err := os.Stat(localPath); os.IsNotExist(err) {
		return nil
	}

	mu := s.projectMu(projectID)
	mu.Lock()
	defer mu.Unlock()

	content, err := s.Generate(ctx, projectID)
	if err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(localPath, "VIBECTL.md"), []byte(content), 0644); err != nil {
		return fmt.Errorf("write VIBECTL.md: %w", err)
	}

	if err := ensureClaudeMdReference(localPath); err != nil {
		slog.Error("failed to ensure CLAUDE.md reference", "error", err)
	}
	if err := ensureGitignoreEntry(localPath, "VIBECTL.md"); err != nil {
		slog.Error("failed to ensure .gitignore entry", "error", err)
	}

	now := time.Now().UTC()
	_ = s.projects.SetVibectlMdGeneratedAt(ctx, projectID, now)

	// Notify active sessions of the update
	if s.OnWrite != nil {
		go s.OnWrite(projectID, content)
	}
	return nil
}

// UpdateSection regenerates specific sections of an existing VIBECTL.md.
func (s *VibectlMdService) UpdateSection(ctx context.Context, projectID string, sectionNames ...string) error {
	project, err := s.projects.GetByID(ctx, projectID)
	if err != nil || project == nil {
		project, err = s.projects.GetByCode(ctx, projectID)
	}
	if err != nil || project == nil {
		return fmt.Errorf("project not found")
	}
	localPath := project.Links.LocalPath
	if localPath == "" {
		return nil
	}

	mdPath := filepath.Join(localPath, "VIBECTL.md")
	existing, err := os.ReadFile(mdPath)
	if err != nil {
		return s.WriteToProject(ctx, projectID)
	}

	mu := s.projectMu(projectID)
	mu.Lock()
	defer mu.Unlock()

	content := string(existing)

	allIssues, _ := s.issues.ListByProject(ctx, project.Code, nil)
	openIssues := filterOpenIssues(allIssues)
	priorityCounts, _ := s.issues.CountByPriority(ctx, project.Code)
	typeCounts := countIssuesByType(openIssues)
	decisions, _ := s.decisions.ListRecent(ctx, project.Code, 20)
	latestSession, _ := s.sessions.GetLatest(ctx, project.Code)

	for _, name := range sectionNames {
		var sc string
		switch name {
		case "status":
			sc = s.genStatus(openIssues, priorityCounts, typeCounts, latestSession)
		case "focus":
			sc = s.genFocus(openIssues)
		case "goals":
			sc = s.genGoals(project)
		case "deployment":
			sc = s.genDeployment(project)
		case "decisions":
			sc = s.genDecisions(decisions)
		case "feedback":
			feedbackItems, _ := s.feedback.ListByProject(ctx, project.Code)
			sc = genPendingFeedback(feedbackItems)
		case "themes":
			sc = s.genThemes(project)
		case "architecture":
			sc = s.genArchitecture(project)
		default:
			continue
		}

		start := fmt.Sprintf("<!-- vibectl:section:%s -->", name)
		end := fmt.Sprintf("<!-- vibectl:end:%s -->", name)
		si := strings.Index(content, start)
		ei := strings.Index(content, end)
		if si >= 0 && ei > si {
			content = content[:si+len(start)] + "\n" + sc + content[ei:]
		}
	}

	// Update header timestamp
	now := time.Now().UTC()
	if idx := strings.Index(content, "Last generated:"); idx >= 0 {
		eol := strings.Index(content[idx:], "-->")
		if eol >= 0 {
			content = content[:idx] + "Last generated: " + now.Format(time.RFC3339) + " " + content[idx+eol:]
		}
	}

	return os.WriteFile(mdPath, []byte(content), 0644)
}

// RegenerateAll regenerates VIBECTL.md for all projects with a localPath.
func (s *VibectlMdService) RegenerateAll(ctx context.Context) (int, error) {
	projects, err := s.projects.List(ctx)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, p := range projects {
		if p.Links.LocalPath == "" {
			continue
		}
		if err := s.WriteToProject(ctx, p.ID.Hex()); err != nil {
			slog.Error("failed to generate VIBECTL.md", "project", p.Code, "error", err)
			continue
		}
		count++
	}
	return count, nil
}

// --- Section generators ---

func (s *VibectlMdService) genStatus(openIssues []models.Issue, priorityCounts map[string]int, typeCounts map[string]int, latestSession *models.SessionLog) string {
	var b strings.Builder
	total := len(openIssues)
	p0, p1, p2 := priorityCounts["P0"], priorityCounts["P1"], priorityCounts["P2"]
	rest := total - p0 - p1 - p2
	if rest < 0 {
		rest = 0
	}
	fmt.Fprintf(&b, "- **Open Issues:** %d (%d P0, %d P1, %d P2, %d P3+)\n", total, p0, p1, p2, rest)
	fmt.Fprintf(&b, "- **Open Bugs:** %d\n", typeCounts["bug"])
	fmt.Fprintf(&b, "- **Open Features:** %d\n", typeCounts["feature"])
	fmt.Fprintf(&b, "- **Open Ideas:** %d\n", typeCounts["idea"])

	sess := "No sessions recorded"
	if latestSession != nil {
		if latestSession.Summary != "" {
			sess = latestSession.Summary
		} else {
			sess = fmt.Sprintf("Session on %s (%s)", latestSession.StartedAt.Format("2006-01-02"), latestSession.Status)
		}
	}
	fmt.Fprintf(&b, "- **Last Session:** %s\n", sess)
	return b.String()
}

func (s *VibectlMdService) genFocus(openIssues []models.Issue) string {
	var b strings.Builder
	var found bool
	for _, iss := range openIssues {
		if string(iss.Priority) == "P0" || string(iss.Priority) == "P1" {
			fmt.Fprintf(&b, "- **%s** (%s, %s): %s\n", iss.IssueKey, iss.Type, iss.Status, iss.Title)
			found = true
		}
	}
	if !found {
		b.WriteString("No critical or high-priority issues open.\n")
	}
	return b.String()
}

func (s *VibectlMdService) genGoals(project *models.Project) string {
	if len(project.Goals) == 0 {
		return "No project goals defined. Add goals in VibeCtl project settings to enable PM review analysis.\n"
	}
	var b strings.Builder
	for _, g := range project.Goals {
		fmt.Fprintf(&b, "- %s\n", g)
	}
	return b.String()
}

func (s *VibectlMdService) genDeployment(project *models.Project) string {
	var b strings.Builder
	hc := project.HealthCheck

	b.WriteString("### Environments\n\n")
	b.WriteString("**Development:**\n")
	b.WriteString("- Frontend: " + strOr(hc, func() string { return hc.Frontend.DevURL }, "Not configured") + "\n")
	b.WriteString("- Backend: " + strOr(hc, func() string { return hc.Backend.DevURL }, "Not configured") + "\n\n")
	b.WriteString("**Production:**\n")
	b.WriteString("- Frontend: " + strOr(hc, func() string { return hc.Frontend.ProdURL }, "Not configured") + "\n")
	b.WriteString("- Backend: " + strOr(hc, func() string { return hc.Backend.ProdURL }, "Not configured") + "\n\n")

	mon := "Disabled"
	if hc != nil && hc.MonitorEnv != "" {
		mon = hc.MonitorEnv
	}
	fmt.Fprintf(&b, "**Monitoring:** %s\n\n", mon)

	dep := project.Deployment
	if dep != nil {
		b.WriteString("### Deployment Commands\n\n")
		writeCmd(&b, "Start Dev", dep.StartDev)
		writeCmd(&b, "Stop Dev", dep.StopDev)
		writeCmd(&b, "Deploy Production", dep.DeployProd)
		writeCmd(&b, "Restart Production", dep.RestartProd)
		writeCmd(&b, "View Logs", dep.ViewLogs)

		if dep.Provider == "flyio" && dep.FlyApp != "" {
			b.WriteString("### Fly.io\n")
			region := dep.FlyRegion
			if region == "" {
				region = "auto"
			}
			fmt.Fprintf(&b, "- **App Name:** %s\n", dep.FlyApp)
			fmt.Fprintf(&b, "- **Region:** %s\n", region)
			fmt.Fprintf(&b, "- Deploy: `fly deploy`\n")
			fmt.Fprintf(&b, "- Restart: `fly apps restart %s`\n", dep.FlyApp)
			fmt.Fprintf(&b, "- Logs: `fly logs -a %s`\n", dep.FlyApp)
			fmt.Fprintf(&b, "- Status: `fly status -a %s`\n", dep.FlyApp)
			fmt.Fprintf(&b, "- SSH: `fly ssh console -a %s`\n\n", dep.FlyApp)
		}

		if dep.Notes != "" {
			b.WriteString("### Deployment Notes\n")
			b.WriteString(dep.Notes + "\n\n")
		}
	}

	return b.String()
}

func (s *VibectlMdService) genDecisions(decisions []models.Decision) string {
	if len(decisions) == 0 {
		return "No decisions recorded yet.\n"
	}
	var b strings.Builder
	for _, d := range decisions {
		fmt.Fprintf(&b, "- **%s** — %s\n", d.Timestamp.Format("2006-01-02"), d.Summary)
	}
	return b.String()
}

func genPendingFeedback(items []models.FeedbackItem) string {
	var pending []models.FeedbackItem
	for _, item := range items {
		if item.TriageStatus == models.TriageStatusPending || item.TriageStatus == models.TriageStatusTriaged {
			pending = append(pending, item)
		}
	}
	if len(pending) == 0 {
		return "No pending feedback items.\n"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d item(s) awaiting review:\n\n", len(pending))
	for i, item := range pending {
		if i >= 3 {
			fmt.Fprintf(&b, "- ...and %d more\n", len(pending)-3)
			break
		}
		snippet := item.RawContent
		if len(snippet) > 100 {
			snippet = snippet[:100] + "…"
		}
		status := "pending"
		if item.TriageStatus == models.TriageStatusTriaged {
			status = "triaged"
		}
		fmt.Fprintf(&b, "- [%s] %s (%s)\n", status, snippet, item.SubmittedAt.Format("2006-01-02"))
	}
	return b.String()
}

func (s *VibectlMdService) genThemes(project *models.Project) string {
	if len(project.RecurringThemes) == 0 {
		return "No recurring themes detected yet. Submit and triage feedback to surface patterns.\n"
	}
	var b strings.Builder
	for _, t := range project.RecurringThemes {
		fmt.Fprintf(&b, "- %s (%d feedback items", t.Theme, t.FeedbackCount)
		if len(t.RelatedIssues) > 0 {
			fmt.Fprintf(&b, " / %s", strings.Join(t.RelatedIssues, ", "))
		}
		b.WriteString(")\n")
	}
	return b.String()
}

func (s *VibectlMdService) genArchitecture(project *models.Project) string {
	if project.ArchitectureSummary == "" {
		return "Architecture summary not yet generated. Run a PM review or trigger VIBECTL.md regeneration to populate.\n"
	}
	return project.ArchitectureSummary + "\n"
}

// --- Helpers ---

func writeSection(b *strings.Builder, heading, name, content string) {
	fmt.Fprintf(b, "## %s\n", heading)
	fmt.Fprintf(b, "<!-- vibectl:section:%s -->\n", name)
	b.WriteString(content)
	fmt.Fprintf(b, "<!-- vibectl:end:%s -->\n\n", name)
}

func filterOpenIssues(issues []models.Issue) []models.Issue {
	var out []models.Issue
	for _, iss := range issues {
		if !iss.Archived && iss.Status != "closed" {
			out = append(out, iss)
		}
	}
	return out
}

func countIssuesByType(issues []models.Issue) map[string]int {
	counts := map[string]int{"bug": 0, "feature": 0, "idea": 0}
	for _, iss := range issues {
		counts[string(iss.Type)]++
	}
	return counts
}

func parseExistingSections(content string) map[string]string {
	sections := make(map[string]string)
	for {
		startTag := "<!-- vibectl:section:"
		si := strings.Index(content, startTag)
		if si < 0 {
			break
		}
		nameStart := si + len(startTag)
		nameEnd := strings.Index(content[nameStart:], " -->")
		if nameEnd < 0 {
			break
		}
		name := content[nameStart : nameStart+nameEnd]
		contentStart := nameStart + nameEnd + len(" -->\n")
		if contentStart > len(content) {
			contentStart = nameStart + nameEnd + len(" -->")
		}

		endTag := fmt.Sprintf("<!-- vibectl:end:%s -->", name)
		ei := strings.Index(content[contentStart:], endTag)
		if ei < 0 {
			break
		}
		sections[name] = content[contentStart : contentStart+ei]
		content = content[contentStart+ei+len(endTag):]
	}
	return sections
}

func ensureClaudeMdReference(localPath string) error {
	refLine := "Read VIBECTL.md for current project status, deployment details, and issue context before starting work.\n"
	claudePath := filepath.Join(localPath, "CLAUDE.md")

	existing, err := os.ReadFile(claudePath)
	if err != nil {
		// File doesn't exist — create it
		return os.WriteFile(claudePath, []byte(refLine), 0644)
	}

	if strings.Contains(string(existing), "VIBECTL.md") {
		return nil // already referenced
	}

	// Prepend reference
	newContent := refLine + "\n" + string(existing)
	return os.WriteFile(claudePath, []byte(newContent), 0644)
}

// ensureGitignoreEntry adds an entry to .gitignore if the file exists and doesn't already contain it.
// Does nothing if there's no .gitignore (doesn't create one).
func ensureGitignoreEntry(localPath, entry string) error {
	gitignorePath := filepath.Join(localPath, ".gitignore")
	existing, err := os.ReadFile(gitignorePath)
	if err != nil {
		return nil // no .gitignore — don't create one
	}
	content := string(existing)
	// Check if already present (as a whole line)
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) == entry {
			return nil
		}
	}
	// Append with a newline separator if needed
	if len(content) > 0 && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += entry + "\n"
	return os.WriteFile(gitignorePath, []byte(content), 0644)
}

func strOr(hc *models.HealthCheckConfig, valFn func() string, fallback string) string {
	if hc == nil {
		return fallback
	}
	v := valFn()
	if v == "" {
		return fallback
	}
	return v
}

func writeCmd(b *strings.Builder, label, cmd string) {
	fmt.Fprintf(b, "**%s:**\n", label)
	if cmd == "" {
		b.WriteString("```\nNot configured\n```\n\n")
	} else {
		fmt.Fprintf(b, "```\n%s\n```\n\n", cmd)
	}
}
