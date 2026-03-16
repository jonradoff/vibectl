package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/joho/godotenv"
	"github.com/jonradoff/vibectl/internal/agents"
	"github.com/jonradoff/vibectl/pkg/healthz"
	"github.com/jonradoff/vibectl/internal/config"
	"github.com/jonradoff/vibectl/internal/handlers"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/ingestion"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/services"
	"github.com/jonradoff/vibectl/internal/terminal"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	godotenv.Load() // load .env if present

	cfg := config.Load()

	// Connect to MongoDB
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(options.Client().ApplyURI(cfg.MongoDBURI))
	if err != nil {
		slog.Error("failed to connect to MongoDB", "error", err)
		os.Exit(1)
	}
	defer client.Disconnect(context.Background())

	if err := client.Ping(ctx, nil); err != nil {
		slog.Error("failed to ping MongoDB", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to MongoDB")

	db := client.Database(cfg.DatabaseName)

	// Initialize services
	projectService := services.NewProjectService(db)
	issueService := services.NewIssueService(db, projectService)
	feedbackService := services.NewFeedbackService(db)
	sessionService := services.NewSessionService(db)
	healthRecordService := services.NewHealthRecordService(db)
	decisionService := services.NewDecisionService(db)

	// Ensure indexes
	idxCtx := context.Background()
	if err := projectService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure project indexes", "error", err)
	}
	if err := issueService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure issue indexes", "error", err)
	}
	if err := feedbackService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure feedback indexes", "error", err)
	}
	if err := sessionService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure session indexes", "error", err)
	}
	if err := healthRecordService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure health record indexes", "error", err)
	}
	if err := decisionService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure decision indexes", "error", err)
	}

	// Initialize AI agents (nil-safe if no API key)
	var triageAgent *agents.TriageAgent
	var pmAgent *agents.PMReviewAgent
	var themesAgent *agents.ThemesAgent
	var archAgent *agents.ArchitectureAgent
	if cfg.AnthropicKey != "" {
		triageAgent = agents.NewTriageAgent(feedbackService, issueService, projectService, cfg.AnthropicKey)
		pmAgent = agents.NewPMReviewAgent(projectService, issueService, cfg.AnthropicKey)
		themesAgent = agents.NewThemesAgent(feedbackService, issueService, projectService, cfg.AnthropicKey)
		archAgent = agents.NewArchitectureAgent(projectService, cfg.AnthropicKey)
		slog.Info("AI agents initialized")
	} else {
		slog.Warn("ANTHROPIC_API_KEY not set, AI agents disabled")
	}

	// Prompt & Activity Log services
	promptService := services.NewPromptService(db)
	activityLogService := services.NewActivityLogService(db)
	if err := promptService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure prompt indexes", "error", err)
	}
	if err := activityLogService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure activity log indexes", "error", err)
	}

	adminService := services.NewAdminService(db)

	// VIBECTL.md generator
	vibectlMdService := services.NewVibectlMdService(projectService, issueService, feedbackService, sessionService, decisionService, healthRecordService, config.Version)

	// Initialize handlers
	projectHandler := handlers.NewProjectHandler(projectService, issueService, sessionService, feedbackService, activityLogService)
	issueHandler := handlers.NewIssueHandler(issueService, decisionService, vibectlMdService, activityLogService)
	feedbackHandler := handlers.NewFeedbackHandler(feedbackService, triageAgent, themesAgent, decisionService, vibectlMdService, projectService)
	sessionHandler := handlers.NewSessionHandler(sessionService)
	dashboardHandler := handlers.NewDashboardHandler(projectService, issueService, sessionService, feedbackService)
	// GitHub sweeper (nil-safe if no token)
	var ghSweeper *ingestion.GitHubSweeper
	if cfg.GitHubToken != "" {
		ghSweeper = ingestion.NewGitHubSweeper(projectService, feedbackService, cfg.GitHubToken)
	}

	healthCheckHandler := handlers.NewHealthCheckHandler(projectService, healthRecordService)
	uploadHandler := handlers.NewUploadHandler("./uploads")
	agentHandler := handlers.NewAgentHandler(pmAgent, archAgent, ghSweeper, projectService, vibectlMdService, decisionService)

	vibectlMdHandler := handlers.NewVibectlMdHandler(vibectlMdService, decisionService, projectService)
	filesystemHandler := handlers.NewFilesystemHandler(projectService, activityLogService)
	promptHandler := handlers.NewPromptHandler(promptService, activityLogService)
	activityLogHandler := handlers.NewActivityLogHandler(activityLogService)

	serverSourceDir, _ := os.Getwd()

	// Terminal manager
	termManager := terminal.NewManager()
	wsHandler := terminal.NewWebSocketHandler(termManager)

	// Chat session persistence service
	chatSessionService := services.NewChatSessionService(db)
	if err := chatSessionService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure chat session indexes", "error", err)
	}
	// Clean up stale resumable sessions older than 24 hours
	if cleaned, err := chatSessionService.CleanupStale(idxCtx, 24*time.Hour); err != nil {
		slog.Error("failed to cleanup stale chat sessions", "error", err)
	} else if cleaned > 0 {
		slog.Info("cleaned up stale chat sessions", "count", cleaned)
	}

	// Chat history service
	chatHistoryService := services.NewChatHistoryService(db)
	if err := chatHistoryService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure chat history indexes", "error", err)
	}

	// Chat manager (stream-json mode)
	chatManager := terminal.NewChatManager(chatSessionService, chatHistoryService)
	chatWSHandler := terminal.NewChatWebSocketHandler(chatManager, func(projectID, text string) {
		snippet := text
		if len(snippet) > 120 {
			snippet = snippet[:120] + "..."
		}
		meta := bson.M{"fullText": text}
		if oid, err := bson.ObjectIDFromHex(projectID); err == nil {
			activityLogService.LogAsync("prompt_sent", "Sent prompt to Claude Code", &oid, snippet, meta)
		}
	})
	chatHistoryHandler := handlers.NewChatHistoryHandler(chatHistoryService)

	// Admin handler — knows the server's own source directory for self-rebuild
	// onBeforeExec persists chat sessions so they can be resumed after restart
	adminHandler := handlers.NewAdminHandler(serverSourceDir, chatManager.ShutdownAll, adminService)

	// /healthz endpoint — VibeCtl Health Check Protocol (self-monitoring)
	healthzChecks := map[string]healthz.CheckFunc{
		"mongodb": func() error {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			return client.Ping(ctx, nil)
		},
	}
	healthzKPIs := func() []healthz.KPI {
		ctx := context.Background()
		projects, _ := projectService.List(ctx)
		projectCount := float64(len(projects))
		var openIssues float64
		for _, p := range projects {
			issues, err := issueService.ListByProject(ctx, p.ID.Hex(), nil)
			if err == nil {
				openIssues += float64(len(issues))
			}
		}
		return []healthz.KPI{
			{Name: "projects", Value: projectCount, Unit: "count"},
			{Name: "open_issues", Value: openIssues, Unit: "count"},
		}
	}

	// Build router
	r := chi.NewRouter()
	r.Use(middleware.Logging)
	r.Use(middleware.CORS(cfg.AllowedOrigins))

	// Healthz endpoint (before API routes)
	r.Get("/healthz", healthz.Handler(config.Version, healthzChecks, healthzKPIs))

	// WebSocket endpoints
	r.Get("/ws/terminal", wsHandler.HandleConnection)
	r.Get("/ws/chat", chatWSHandler.HandleConnection)

	r.Route("/api/v1", func(r chi.Router) {
		// Static project routes first (before {id} wildcard)
		r.Get("/projects/archived", projectHandler.ListArchived)
		r.Mount("/projects/code", projectHandler.CodeRoutes())

		// All project routes under a single Route block to avoid chi conflicts
		r.Route("/projects", func(r chi.Router) {
			r.Get("/", projectHandler.List)
			r.Post("/", projectHandler.Create)
			r.Route("/{id}", func(r chi.Router) {
				r.Get("/", projectHandler.GetByID)
				r.Put("/", projectHandler.Update)
				r.Delete("/", projectHandler.Delete)
				r.Post("/archive", projectHandler.Archive)
				r.Post("/unarchive", projectHandler.Unarchive)
				r.Get("/dashboard", projectHandler.Dashboard)
				r.Get("/healthcheck", healthCheckHandler.Check)
				r.Get("/healthcheck/history", healthCheckHandler.History)
				r.Mount("/issues", issueHandler.ProjectIssueRoutes())
				r.Get("/issues/archived", issueHandler.ListArchived)
				r.Mount("/feedback", feedbackHandler.ProjectFeedbackRoutes())
				r.Mount("/sessions", sessionHandler.ProjectSessionRoutes())
				r.Get("/chat-history", chatHistoryHandler.ListByProject)
				r.Post("/vibectl-md/generate", vibectlMdHandler.Generate)
				r.Get("/vibectl-md", vibectlMdHandler.GetCurrent)
				r.Get("/vibectl-md/preview", vibectlMdHandler.Preview)
				r.Get("/decisions", vibectlMdHandler.ListDecisions)
				r.Get("/files/list", filesystemHandler.ListDir)
				r.Get("/files/read", filesystemHandler.ReadFile)
				r.Put("/files/write", filesystemHandler.WriteFile)
				r.Mount("/prompts", promptHandler.ProjectPromptRoutes())
			})
		})

		r.Post("/ensure-dir", filesystemHandler.EnsureDir)
		r.Get("/check-dir", filesystemHandler.CheckDir)

		// Admin endpoints
		r.Post("/admin/login", adminHandler.Login)          // public — no auth required
		r.Post("/admin/set-password", adminHandler.SetPassword) // public — protects with current password
		r.With(middleware.AdminAuth(adminService)).Post("/admin/rebuild", adminHandler.Rebuild)
		r.Get("/admin/self-info", adminHandler.SelfInfo)

		r.Get("/chat-history/{historyId}", chatHistoryHandler.GetByID)
		r.Mount("/issues", issueHandler.IssueRoutes())
		r.Mount("/feedback", feedbackHandler.FeedbackRoutes())
		r.Mount("/sessions", sessionHandler.SessionRoutes())
		r.Mount("/dashboard", dashboardHandler.Routes())
		r.Mount("/agents", agentHandler.Routes())
		r.Mount("/uploads", uploadHandler.Routes())
		r.Mount("/prompts", promptHandler.PromptRoutes())
		r.Mount("/activity-log", activityLogHandler.Routes())
	})

	// Serve uploaded files
	r.Handle("/uploads/*", http.StripPrefix("/uploads/", http.FileServer(http.Dir("./uploads"))))

	// Serve machine-readable docs (api.md, cli.md, mcp.md)
	r.Handle("/docs/*", http.StripPrefix("/docs/", http.FileServer(http.Dir("./docs"))))

	// Serve skill.md from project root
	r.Get("/skill.md", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./skill.md")
	})

	// GitHub Comment Sweeper (runs every 15 minutes if token is set)
	if ghSweeper != nil {
		go func() {
			ticker := time.NewTicker(15 * time.Minute)
			defer ticker.Stop()
			// Initial sweep on startup after a short delay.
			time.Sleep(5 * time.Second)
			if count, err := ghSweeper.Sweep(context.Background()); err != nil {
				slog.Error("github sweep error", "error", err)
			} else if count > 0 {
				slog.Info("github sweep complete", "imported", count)
			}
			for range ticker.C {
				if count, err := ghSweeper.Sweep(context.Background()); err != nil {
					slog.Error("github sweep error", "error", err)
				} else if count > 0 {
					slog.Info("github sweep complete", "imported", count)
				}
			}
		}()
		slog.Info("GitHub comment sweeper enabled (15m interval)")
	}

	// Background health check recorder (every 10 minutes)
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()

		runChecks := func() {
			projects, err := projectService.List(context.Background())
			if err != nil {
				slog.Error("health recorder: failed to list projects", "error", err)
				return
			}
			for _, p := range projects {
				if p.HealthCheck == nil || p.HealthCheck.MonitorEnv == "" {
					continue
				}
				cfg := p.HealthCheck
				var frontendURL, backendURL string
				if cfg.MonitorEnv == "dev" {
					frontendURL = cfg.Frontend.DevURL
					backendURL = cfg.Backend.DevURL
				} else if cfg.MonitorEnv == "prod" {
					frontendURL = cfg.Frontend.ProdURL
					backendURL = cfg.Backend.ProdURL
				}
				var results []models.HealthCheckResult
				if frontendURL != "" {
					results = append(results, healthCheckHandler.ProbeFrontend("Frontend", frontendURL))
				}
				if backendURL != "" {
					results = append(results, healthCheckHandler.Probe("Backend", backendURL))
				}
				if len(results) > 0 {
					if err := healthRecordService.Insert(context.Background(), p.ID, results); err != nil {
						slog.Error("health recorder: failed to insert record", "projectID", p.ID, "error", err)
					}
				}
			}
		}

		// Initial check after a short delay
		time.Sleep(10 * time.Second)
		runChecks()

		for range ticker.C {
			runChecks()
		}
	}()
	slog.Info("health check recorder enabled (10m interval)")

	// Server
	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: r,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("shutting down server")

		// Persist all active chat sessions so they can be resumed after restart
		chatManager.ShutdownAll()

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		srv.Shutdown(shutdownCtx)
	}()

	// Log server startup
	activityLogService.LogAsync("backend_start", "VibeCtl server started on port "+cfg.Port+" (v"+config.Version+")", nil, "", nil)

	slog.Info("starting VibeCtl server", "port", cfg.Port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}
