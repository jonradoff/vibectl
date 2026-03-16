package agents

import (
	"context"
	"fmt"
)

type SummarizerAgent struct {
	aiClient *AIClient
}

func NewSummarizerAgent(apiKey string) *SummarizerAgent {
	return &SummarizerAgent{
		aiClient: NewAIClient(apiKey),
	}
}

func (a *SummarizerAgent) SummarizeSession(ctx context.Context, projectName, transcript string) (string, error) {
	prompt := fmt.Sprintf(`Summarize this Claude Code terminal session for the project "%s".
Focus on: what was accomplished, what issues were worked on, what's still in progress, and any problems encountered.
Keep it to 2-3 sentences.

Terminal transcript:
%s`, projectName, transcript)

	return a.aiClient.Complete(ctx, prompt)
}
