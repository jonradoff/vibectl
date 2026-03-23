package mcp

import (
	"fmt"

	"github.com/mark3labs/mcp-go/server"
)

// MCPServer wraps the MCP protocol server with vibectl service access.
type MCPServer struct {
	backend Backend
	server  *server.MCPServer
}

// NewMCPServer creates an MCP server with all vibectl tools and resources registered.
func NewMCPServer(backend Backend) *MCPServer {
	s := &MCPServer{
		backend: backend,
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
