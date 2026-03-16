package mcp

import (
	"fmt"

	"github.com/jonradoff/vibectl/internal/services"
	"github.com/mark3labs/mcp-go/server"
)

// MCPServer wraps the MCP protocol server with vibectl service access.
type MCPServer struct {
	projects     *services.ProjectService
	issues       *services.IssueService
	feedback     *services.FeedbackService
	decisions    *services.DecisionService
	sessions     *services.SessionService
	healthRecords *services.HealthRecordService
	prompts      *services.PromptService
	vibectlMd    *services.VibectlMdService
	server       *server.MCPServer
}

// NewMCPServer creates an MCP server with all vibectl tools and resources registered.
func NewMCPServer(
	ps *services.ProjectService,
	is *services.IssueService,
	fs *services.FeedbackService,
	ds *services.DecisionService,
	ss *services.SessionService,
	hrs *services.HealthRecordService,
	proms *services.PromptService,
	vm *services.VibectlMdService,
) *MCPServer {
	s := &MCPServer{
		projects:     ps,
		issues:       is,
		feedback:     fs,
		decisions:    ds,
		sessions:     ss,
		healthRecords: hrs,
		prompts:      proms,
		vibectlMd:    vm,
		server: server.NewMCPServer(
			"vibectl",
			"1.0.0",
			server.WithToolCapabilities(false),
			server.WithResourceCapabilities(false, false),
			server.WithRecovery(),
		),
	}

	s.registerTools()
	s.registerResources()

	return s
}

// ServeStdio runs the MCP server using stdio transport.
func (s *MCPServer) ServeStdio() error {
	return server.ServeStdio(s.server)
}

// ServeHTTP runs the MCP server using streamable HTTP transport.
func (s *MCPServer) ServeHTTP(addr string) error {
	httpServer := server.NewStreamableHTTPServer(s.server,
		server.WithStateLess(true),
	)
	fmt.Printf("vibectl MCP server listening on %s\n", addr)
	return httpServer.Start(addr)
}
