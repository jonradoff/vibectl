package agents

import (
	"regexp"
	"strings"
)

// SafetyWarning represents a potential danger flagged in user-submitted feedback content.
type SafetyWarning struct {
	Severity    string `json:"severity"`    // "danger" or "caution"
	Pattern     string `json:"pattern"`     // the matched pattern
	Description string `json:"description"` // human-readable explanation
}

var dangerPatterns = []struct {
	re   *regexp.Regexp
	desc string
}{
	{regexp.MustCompile(`(?i)rm\s+-rf`), "Destructive file deletion command"},
	{regexp.MustCompile(`(?i)sudo\s+`), "Privileged command execution"},
	{regexp.MustCompile(`(?i)curl\s+.*\|\s*sh`), "Piped remote script execution"},
	{regexp.MustCompile(`(?i)wget\s+.*\|\s*sh`), "Piped remote script execution"},
	{regexp.MustCompile(`(?i)chmod\s+777`), "Insecure file permission change"},
	{regexp.MustCompile(`(?i)/etc/passwd`), "System file access"},
	{regexp.MustCompile(`(?i)DROP\s+TABLE`), "Database destruction command"},
	{regexp.MustCompile(`(?i)DROP\s+DATABASE`), "Database destruction command"},
	{regexp.MustCompile("(?i)`[^`]*rm\\s"), "Shell command in backticks"},
	{regexp.MustCompile(`(?i)>\s*/dev/`), "Device file redirection"},
	{regexp.MustCompile(`(?i)mkfs\s`), "Filesystem format command"},
}

var cautionPatterns = []struct {
	re   *regexp.Regexp
	desc string
}{
	{regexp.MustCompile(`(?i)ignore\s+(all\s+)?previous\s+instructions`), "Prompt injection attempt"},
	{regexp.MustCompile(`(?i)system\s+prompt`), "Prompt injection — references system prompt"},
	{regexp.MustCompile(`(?i)you\s+are\s+now`), "Prompt injection — identity override attempt"},
	{regexp.MustCompile(`(?i)disregard\s+(all|any|the)\s`), "Prompt injection — disregard instructions"},
	{regexp.MustCompile(`(?i)(password|secret|api[_\s]?key|token).*\b(curl|wget|fetch|send|post)\b`), "Potential credential exfiltration"},
	{regexp.MustCompile(`(?i)\b(curl|wget|fetch|send|post)\b.*(password|secret|api[_\s]?key|token)`), "Potential credential exfiltration"},
	{regexp.MustCompile(`(?i)eval\s*\(`), "Dynamic code evaluation"},
	{regexp.MustCompile(`(?i)exec\s*\(`), "Dynamic command execution"},
}

// ScanPrompt checks the raw feedback content (not the generated prompt wrapper) for dangerous patterns.
func ScanPrompt(text string) []SafetyWarning {
	var warnings []SafetyWarning
	seen := map[string]bool{}

	for _, p := range dangerPatterns {
		if loc := p.re.FindString(text); loc != "" {
			key := "danger:" + p.desc
			if !seen[key] {
				seen[key] = true
				warnings = append(warnings, SafetyWarning{
					Severity:    "danger",
					Pattern:     strings.TrimSpace(loc),
					Description: p.desc,
				})
			}
		}
	}

	for _, p := range cautionPatterns {
		if loc := p.re.FindString(text); loc != "" {
			key := "caution:" + p.desc
			if !seen[key] {
				seen[key] = true
				warnings = append(warnings, SafetyWarning{
					Severity:    "caution",
					Pattern:     strings.TrimSpace(loc),
					Description: p.desc,
				})
			}
		}
	}

	return warnings
}
