package agents

import (
	"fmt"
	"strings"

	"github.com/jonradoff/vibectl/internal/models"
)

// GeneratePrompt compiles accepted feedback items into a structured prompt for Claude Code.
func GeneratePrompt(projectName, projectCode string, items []models.FeedbackItem, batchID string) string {
	var b strings.Builder

	b.WriteString(fmt.Sprintf("You are working on %s (%s). The following %d feedback item(s) have been reviewed and accepted by the project maintainer. Please address each one.\n\n", projectName, projectCode, len(items)))

	for i, item := range items {
		title := item.RawContent
		if len(title) > 100 {
			title = title[:100] + "..."
		}
		if item.AIAnalysis != nil && item.AIAnalysis.ProposedIssue != nil && item.AIAnalysis.ProposedIssue.Title != "" {
			title = item.AIAnalysis.ProposedIssue.Title
		}

		b.WriteString(fmt.Sprintf("## Feedback Item %d: %s\n", i+1, title))
		b.WriteString(fmt.Sprintf("- Source: %s", item.SourceType))
		if item.SubmittedBy != "" {
			b.WriteString(fmt.Sprintf(" | Submitted by: %s", item.SubmittedBy))
		}
		b.WriteString(fmt.Sprintf(" | Date: %s\n", item.SubmittedAt.Format("2006-01-02")))
		b.WriteString("- Content:\n<user-content>\n")
		b.WriteString(item.RawContent)
		b.WriteString("\n</user-content>\n")

		if item.AIAnalysis != nil {
			if item.AIAnalysis.Reasoning != "" {
				b.WriteString(fmt.Sprintf("- AI Assessment: %s\n", item.AIAnalysis.Reasoning))
			}
			if item.AIAnalysis.ProposedIssue != nil {
				pi := item.AIAnalysis.ProposedIssue
				b.WriteString(fmt.Sprintf("- Proposed: [%s] %s (Priority: %s)\n", pi.Type, pi.Title, pi.Priority))
				if pi.ReproSteps != "" {
					b.WriteString(fmt.Sprintf("- Repro steps: %s\n", pi.ReproSteps))
				}
			}
		}
		b.WriteString("\n")
	}

	b.WriteString("---\nFor each item, analyze what changes are needed and implement the fix or feature. If any item is unclear or contradictory, note that rather than guessing.\n")
	b.WriteString(fmt.Sprintf("\n<!-- prompt-batch:%s -->\n", batchID))

	return b.String()
}
