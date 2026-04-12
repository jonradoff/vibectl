package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jonradoff/vibectl/internal/agents"
	"github.com/jonradoff/vibectl/internal/config"
	vibemcp "github.com/jonradoff/vibectl/internal/mcp"
	"github.com/jonradoff/vibectl/internal/services"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func main() {
	mongoURI := flag.String("mongodb-uri", "mongodb://localhost:27017", "MongoDB connection URI")
	database := flag.String("database", "vibectl", "MongoDB database name")
	mode := flag.String("mode", "stdio", "Transport mode: stdio or http")
	port := flag.Int("port", 3100, "HTTP port (for http mode)")
	serverURL := flag.String("server-url", "", "VibeCtl server URL for API mode (e.g. https://vibectl.example.com)")
	apiToken := flag.String("api-token", "", "API token for VibeCtl server authentication")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// Allow env vars as fallbacks for server-url and api-token.
	if *serverURL == "" {
		*serverURL = os.Getenv("VIBECTL_URL")
	}
	if *apiToken == "" {
		*apiToken = os.Getenv("VIBECTL_TOKEN")
	}

	var backend vibemcp.Backend

	if *serverURL != "" {
		// API mode: connect to a remote VibeCtl server over HTTP.
		slog.Info("starting vibectl MCP server in API mode", "serverURL", *serverURL)
		backend = vibemcp.NewAPIBackend(*serverURL, *apiToken)
	} else {
		// MongoDB mode: connect directly to MongoDB.
		slog.Info("starting vibectl MCP server in MongoDB mode")

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		client, err := mongo.Connect(options.Client().ApplyURI(*mongoURI))
		if err != nil {
			slog.Error("failed to connect to MongoDB", "error", err)
			os.Exit(1)
		}

		if err := client.Ping(ctx, nil); err != nil {
			slog.Error("failed to ping MongoDB", "error", err)
			os.Exit(1)
		}
		slog.Info("connected to MongoDB", "uri", *mongoURI, "database", *database)

		db := client.Database(*database)

		// Create services.
		projectService := services.NewProjectService(db, nil) // no event bus in standalone MCP
		issueService := services.NewIssueService(db, projectService)
		feedbackService := services.NewFeedbackService(db)
		sessionService := services.NewSessionService(db)
		decisionService := services.NewDecisionService(db)
		healthRecordService := services.NewHealthRecordService(db)
		promptService := services.NewPromptService(db)
		vibectlMdService := services.NewVibectlMdService(projectService, issueService, feedbackService, sessionService, decisionService, healthRecordService, config.Version)

		mongoBackend := vibemcp.NewMongoBackend(
			projectService,
			issueService,
			feedbackService,
			decisionService,
			sessionService,
			healthRecordService,
			promptService,
			vibectlMdService,
		)
		if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
			ta := agents.NewTriageAgent(feedbackService, issueService, projectService, key)
			mongoBackend.SetTriageAgent(ta)
		}
		backend = mongoBackend
	}

	// Create MCP server with the selected backend.
	mcpServer := vibemcp.NewMCPServer(backend)

	switch *mode {
	case "stdio":
		slog.Info("starting vibectl MCP server in stdio mode")
		if err := mcpServer.ServeStdio(); err != nil {
			slog.Error("MCP stdio server error", "error", err)
			os.Exit(1)
		}
	case "http":
		addr := fmt.Sprintf(":%d", *port)
		slog.Info("starting vibectl MCP server in HTTP mode", "addr", addr)
		if err := mcpServer.ServeHTTP(addr); err != nil {
			slog.Error("MCP HTTP server error", "error", err)
			os.Exit(1)
		}
	default:
		slog.Error("invalid mode", "mode", *mode)
		fmt.Fprintf(os.Stderr, "invalid mode %q: must be stdio or http\n", *mode)
		os.Exit(1)
	}
}
