package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/joho/godotenv"
	"github.com/jonradoff/vibectl/internal/agents"
	vibectlclient "github.com/jonradoff/vibectl/internal/client"
	"github.com/jonradoff/vibectl/internal/config"
	"github.com/jonradoff/vibectl/internal/events"
	"github.com/jonradoff/vibectl/internal/handlers"
	"github.com/jonradoff/vibectl/internal/ingestion"
	"github.com/jonradoff/vibectl/internal/middleware"
	"github.com/jonradoff/vibectl/internal/models"
	"github.com/jonradoff/vibectl/internal/services"
	"github.com/jonradoff/vibectl/internal/terminal"
	"github.com/jonradoff/vibectl/pkg/healthz"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// parseMongoUser extracts the username from a MongoDB URI, or returns "" if none.
func parseMongoUser(uri string) string {
	// Strip scheme
	for _, prefix := range []string{"mongodb+srv://", "mongodb://"} {
		if strings.HasPrefix(uri, prefix) {
			rest := uri[len(prefix):]
			// If there's an @ sign, user info precedes it
			if atIdx := strings.Index(rest, "@"); atIdx > 0 {
				userInfo := rest[:atIdx]
				// user:password or just user
				if colonIdx := strings.Index(userInfo, ":"); colonIdx > 0 {
					return userInfo[:colonIdx]
				}
				return userInfo
			}
			return ""
		}
	}
	return ""
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	godotenv.Load() // load .env if present

	cfg := config.Load()

	if cfg.Mode == "client" {
		runClientMode(cfg)
		return
	}

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

	// -------------------------------------------------------------------------
	// Event bus (created before handlers so it can be injected)
	// -------------------------------------------------------------------------
	eventBus := events.NewBus()

	// -------------------------------------------------------------------------
	// Core services
	// -------------------------------------------------------------------------
	clientInstanceService := services.NewClientInstanceService(db)
	projectService := services.NewProjectService(db, eventBus)
	issueService := services.NewIssueService(db, projectService)
	feedbackService := services.NewFeedbackService(db)
	sessionService := services.NewSessionService(db) // work-session logs, NOT auth sessions
	healthRecordService := services.NewHealthRecordService(db)
	decisionService := services.NewDecisionService(db)
	commentService := services.NewCommentService(db)
	settingsService := services.NewSettingsService(db)
	webhookService := services.NewWebhookService(db)
	adminService := services.NewAdminService(db) // legacy admin (CLI compat)

	claudeUsageService := services.NewClaudeUsageService(db)

	// Multi-user services
	userService := services.NewUserService(db, cfg.APIKeyEncryptionKey)
	authSessionService := services.NewAuthSessionService(db, userService)
	memberService := services.NewProjectMemberService(db, userService)
	checkoutService := services.NewCheckoutService(db, userService)
	apiKeyService := services.NewAPIKeyService(db)
	cloneService := services.NewCloneService(projectService, userService, cfg.ReposDir, cfg.GitHubToken)

	// -------------------------------------------------------------------------
	// Ensure indexes
	// -------------------------------------------------------------------------
	idxCtx := context.Background()
	for _, fn := range []func(context.Context) error{
		clientInstanceService.EnsureIndexes,
		projectService.EnsureIndexes,
		issueService.EnsureIndexes,
		feedbackService.EnsureIndexes,
		sessionService.EnsureIndexes,
		healthRecordService.EnsureIndexes,
		decisionService.EnsureIndexes,
		commentService.EnsureIndexes,
		settingsService.EnsureIndexes,
		userService.EnsureIndexes,
		authSessionService.EnsureIndexes,
		memberService.EnsureIndexes,
		checkoutService.EnsureIndexes,
		claudeUsageService.EnsureIndexes,
	} {
		if err := fn(idxCtx); err != nil {
			slog.Error("failed to ensure indexes", "error", err)
		}
	}

	// -------------------------------------------------------------------------
	// Startup migration: if no users exist but an admin password is set,
	// auto-create the admin fallback user from the legacy admin doc.
	// Also seed project ownership for each existing project.
	// -------------------------------------------------------------------------
	userCount, _ := userService.Count(idxCtx)
	if userCount == 0 {
		hash, err := adminService.GetPasswordHash(idxCtx)
		if err == nil && hash != "" {
			adminUser, err := userService.CreateAdminFallback(idxCtx, hash)
			if err != nil {
				slog.Error("failed to migrate admin user", "error", err)
			} else {
				slog.Info("migrated legacy admin → users collection", "userId", adminUser.ID.Hex())
				// Seed admin as owner of all existing projects
				projects, _ := projectService.List(idxCtx)
				for _, p := range projects {
					memberService.SeedOwner(idxCtx, p.ID, adminUser.ID)
				}
				slog.Info("seeded admin as owner of existing projects", "count", len(projects))
			}
		}
	}

	// -------------------------------------------------------------------------
	// AI agents (nil-safe if no API key)
	// -------------------------------------------------------------------------
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

	// -------------------------------------------------------------------------
	// Additional services
	// -------------------------------------------------------------------------
	promptService := services.NewPromptService(db)
	activityLogService := services.NewActivityLogService(db)
	planService := services.NewPlanService(db)
	if err := promptService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure prompt indexes", "error", err)
	}
	if err := activityLogService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure activity log indexes", "error", err)
	}
	if err := planService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure plan indexes", "error", err)
	}

	vibectlMdService := services.NewVibectlMdService(projectService, issueService, feedbackService, sessionService, decisionService, healthRecordService, config.Version)

	// Terminal + chat
	termManager := terminal.NewManager()
	wsHandler := terminal.NewWebSocketHandler(termManager)
	shellWSHandler := terminal.NewShellWebSocketHandler(termManager, authSessionService)
	shellWSHandler.ShellEnabled = func(ctx context.Context) (bool, error) {
		s, err := settingsService.Get(ctx)
		if err != nil {
			return false, err
		}
		return s.ExperimentalShell, nil
	}
	chatSessionService := services.NewChatSessionService(db)
	if err := chatSessionService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure chat session indexes", "error", err)
	}
	if cleaned, err := chatSessionService.CleanupStale(idxCtx, 24*time.Hour); err != nil {
		slog.Error("failed to cleanup stale chat sessions", "error", err)
	} else if cleaned > 0 {
		slog.Info("cleaned up stale chat sessions", "count", cleaned)
	}
	chatHistoryService := services.NewChatHistoryService(db)
	if err := chatHistoryService.EnsureIndexes(idxCtx); err != nil {
		slog.Error("failed to ensure chat history indexes", "error", err)
	}

	chatManager := terminal.NewChatManager(chatSessionService, chatHistoryService)
	chatManager.UsageRecorder = func(tokenHash, projectID, sessionID, model string, inputTokens, outputTokens, cacheRead, cacheCreation int64) {
		rec := &models.ClaudeUsageRecord{
			TokenHash:           tokenHash,
			ProjectID:           projectID,
			SessionID:           sessionID,
			Model:               model,
			InputTokens:         inputTokens,
			OutputTokens:        outputTokens,
			CacheReadTokens:     cacheRead,
			CacheCreationTokens: cacheCreation,
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := claudeUsageService.Record(ctx, rec); err != nil {
				slog.Error("failed to record claude usage", "error", err)
			}
		}()
	}
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
	chatWSHandler.SetPlanLoggers(
		func(projectID, requestID, planText string) {
			plan := &models.Plan{
				RequestID: requestID,
				PlanText:  planText,
				Status:    "pending",
			}
			if oid, err := bson.ObjectIDFromHex(projectID); err == nil {
				plan.ProjectID = &oid
			}
			planService.CreateAsync(plan)

			// Also log to activity log
			snippet := planText
			if len(snippet) > 120 {
				snippet = snippet[:120] + "..."
			}
			meta := bson.M{"fullText": planText, "requestId": requestID}
			if oid, err := bson.ObjectIDFromHex(projectID); err == nil {
				activityLogService.LogAsync("plan_received", "Claude Code generated a plan", &oid, snippet, meta)
			}
		},
		func(projectID, requestID, status, feedback string) {
			if oid, err := bson.ObjectIDFromHex(projectID); err == nil {
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					planService.UpdateStatusByRequestID(ctx, &oid, requestID, status, feedback)
				}()
				msg := "Plan " + status
				if feedback != "" {
					msg += " with feedback"
				}
				activityLogService.LogAsync("plan_"+status, msg, &oid, feedback, bson.M{"requestId": requestID})
			}
		},
	)
	chatHistoryHandler := handlers.NewChatHistoryHandler(chatHistoryService)
	chatSessionHandler := handlers.NewChatSessionHandler(chatSessionService, chatHistoryService)
	planHandler := handlers.NewPlanHandler(planService)

	// -------------------------------------------------------------------------
	// Handlers
	// -------------------------------------------------------------------------
	frontendURL := cfg.AllowedOrigins[0] // e.g. http://localhost:4370

	authHandler := handlers.NewAuthHandler(userService, authSessionService, adminService,
		cfg.GitHubClientID, cfg.GitHubClientSecret, cfg.GitHubToken, cfg.BaseURL, frontendURL, cfg.AnthropicKey != "")
	userHandler := handlers.NewUserHandler(userService, authSessionService)
	memberHandler := handlers.NewProjectMemberHandler(memberService, projectService)
	checkoutHandler := handlers.NewCheckoutHandler(checkoutService, memberService)
	ciHandler := handlers.NewCIHandler(projectService, memberService, cfg.GitHubToken)
	apiKeyHandler := handlers.NewAPIKeyHandler(apiKeyService)

	projectHandler := handlers.NewProjectHandler(projectService, issueService, sessionService, feedbackService, activityLogService, memberService, eventBus)
	issueHandler := handlers.NewIssueHandler(issueService, decisionService, vibectlMdService, activityLogService, commentService, webhookService, eventBus)
	feedbackHandler := handlers.NewFeedbackHandler(feedbackService, issueService, triageAgent, themesAgent, decisionService, vibectlMdService, projectService, activityLogService, webhookService, eventBus)
	settingsHandler := handlers.NewSettingsHandler(settingsService, cfg.DatabaseName, parseMongoUser(cfg.MongoDBURI))
	sessionHandler := handlers.NewSessionHandler(sessionService, eventBus)
	dashboardHandler := handlers.NewDashboardHandler(projectService, issueService, sessionService, feedbackService, memberService, activityLogService, healthRecordService)

	var ghSweeper *ingestion.GitHubSweeper
	if cfg.GitHubToken != "" {
		ghSweeper = ingestion.NewGitHubSweeper(projectService, feedbackService, cfg.GitHubToken)
	}

	claudeUsageHandler := handlers.NewClaudeUsageHandler(claudeUsageService)
	healthCheckHandler := handlers.NewHealthCheckHandler(projectService, healthRecordService)
	uploadHandler := handlers.NewUploadHandler("./uploads")
	agentHandler := handlers.NewAgentHandler(pmAgent, archAgent, ghSweeper, projectService, vibectlMdService, decisionService)
	vibectlMdHandler := handlers.NewVibectlMdHandler(vibectlMdService, decisionService, projectService)
	filesystemHandler := handlers.NewFilesystemHandler(projectService, activityLogService)
	promptHandler := handlers.NewPromptHandler(promptService, activityLogService, memberService, eventBus)
	activityLogHandler := handlers.NewActivityLogHandler(activityLogService)
	cloneHandler := handlers.NewCloneHandler(cloneService, projectService)
	clientInstanceHandler := handlers.NewClientInstanceHandler(clientInstanceService)
	eventsHandler := handlers.NewEventsHandler(eventBus)

	serverSourceDir, _ := os.Getwd()
	adminHandler := handlers.NewAdminHandler(serverSourceDir, chatManager.ShutdownAll, adminService)

	// -------------------------------------------------------------------------
	// Healthz
	// -------------------------------------------------------------------------
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

	// -------------------------------------------------------------------------
	// Router
	// -------------------------------------------------------------------------
	r := chi.NewRouter()
	r.Use(middleware.Logging)
	r.Use(middleware.CORS(cfg.AllowedOrigins))

	r.Get("/healthz", healthz.Handler(config.Version, healthzChecks, healthzKPIs))

	// WebSocket endpoints (public — auth handled inside the handlers)
	r.Get("/ws/terminal", wsHandler.HandleConnection)
	r.Get("/ws/chat", chatWSHandler.HandleConnection)
	r.Get("/ws/shell", shellWSHandler.HandleConnection)

	r.Route("/api/v1", func(r chi.Router) {
		// ---------------------------------------------------------------
		// Public auth endpoints — always accessible
		// ---------------------------------------------------------------
		r.Get("/auth/status", authHandler.AuthStatus)
		r.Post("/auth/login", authHandler.Login)
		r.Get("/auth/github", authHandler.GitHubLogin)
		r.Get("/auth/github/callback", authHandler.GitHubCallback)

		// Legacy admin endpoints (CLI backward compat — keep working)
		r.Get("/admin/auth-status", authHandler.AuthStatus)       // same handler
		r.Post("/admin/login", authHandler.Login)                  // same handler
		r.Post("/admin/set-password", adminHandler.SetPassword)    // CLI: vibectl admin set-password

		// ---------------------------------------------------------------
		// Protected routes
		// ---------------------------------------------------------------
		r.Group(func(r chi.Router) {
			r.Use(middleware.UserAuth(userService, authSessionService, apiKeyService))

			// Auth self-endpoints
			r.Get("/auth/me", authHandler.Me)
			r.Post("/auth/logout", authHandler.Logout)
			r.Post("/auth/change-password", authHandler.ChangePassword)
			r.Get("/auth/github/link", authHandler.GitHubLink)

			// Auth self-endpoints (API keys for current user)
			r.Mount("/api-keys", apiKeyHandler.Routes())

			// User profile (self)
			r.Mount("/users/me", userHandler.SelfRoutes())

			// User directory (any authenticated user — for member management)
			r.Mount("/users/directory", userHandler.DirectoryRoutes())

			// User management (super_admin only — RequireSuperAdmin applied inside Routes())
			r.Mount("/users", userHandler.Routes())

			// Static project routes (before {id} wildcard)
			r.Get("/projects/archived", projectHandler.ListArchived)
			r.Mount("/projects/code", projectHandler.CodeRoutes())

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
					r.Get("/my-role", projectHandler.MyRole)
					r.Post("/activity", activityLogHandler.PostActivity)
					r.Get("/healthcheck", healthCheckHandler.Check)
					r.Get("/healthcheck/history", healthCheckHandler.History)
					r.Mount("/issues", issueHandler.ProjectIssueRoutes())
					r.Get("/issues/archived", issueHandler.ListArchived)
					r.Mount("/feedback", feedbackHandler.ProjectFeedbackRoutes())
					r.Mount("/sessions", sessionHandler.ProjectSessionRoutes())
					r.Get("/chat-history", chatHistoryHandler.ListByProject)
				r.Route("/chat-session", chatSessionHandler.Routes())
					r.Post("/vibectl-md/generate", vibectlMdHandler.Generate)
					r.Get("/vibectl-md", vibectlMdHandler.GetCurrent)
					r.Get("/vibectl-md/preview", vibectlMdHandler.Preview)
					r.Get("/decisions", vibectlMdHandler.ListDecisions)
					r.Get("/files/list", filesystemHandler.ListDir)
					r.Get("/files/read", filesystemHandler.ReadFile)
					r.Put("/files/write", filesystemHandler.WriteFile)
					r.Mount("/prompts", promptHandler.ProjectPromptRoutes())
					// Multi-user additions
					r.Mount("/members", memberHandler.Routes())
					r.Mount("/checkout", checkoutHandler.Routes())
					r.Mount("/ci", ciHandler.Routes())
					// Multi-module units
					r.Get("/units", projectHandler.ListUnits)
					r.Post("/units", projectHandler.AddUnit)
					r.Post("/units/attach", projectHandler.AttachUnit)
					r.Post("/units/{unitId}/detach", projectHandler.DetachUnit)
					// Clone / remote dev
					r.Mount("/", cloneHandler.Routes())
				})
			})

			r.Post("/ensure-dir", filesystemHandler.EnsureDir)
			r.Get("/check-dir", filesystemHandler.CheckDir)
			r.Get("/detect-git-remote", filesystemHandler.DetectGitRemote)
			r.Get("/detect-fly-toml", filesystemHandler.DetectFlyToml)
			r.Get("/detect-start-sh", filesystemHandler.DetectStartSh)
			r.Get("/detect-deploy-sh", filesystemHandler.DetectDeploySh)
			r.Get("/detect-project-scripts", filesystemHandler.DetectProjectScripts)
			r.Mount("/clone", cloneHandler.GlobalRoutes())
			r.Mount("/ci", ciHandler.BulkRoutes())

			// Admin endpoints
			r.Post("/admin/rebuild", adminHandler.Rebuild)
			r.Get("/admin/self-info", adminHandler.SelfInfo)
			r.Get("/admin/claude-auth-status", adminHandler.ClaudeAuthStatus)
			r.Get("/admin/claude-login", adminHandler.ClaudeLogin)
			r.Post("/admin/claude-login-code", adminHandler.ClaudeLoginCode)
			r.Post("/admin/claude-token-direct", adminHandler.ClaudeTokenDirect)
			r.Get("/admin/mcp-servers", adminHandler.ListMCPServers)
			r.Get("/admin/subscription-usage", adminHandler.GetSubscriptionUsage)

			r.Get("/chat-history/{historyId}", chatHistoryHandler.GetByID)
			r.Mount("/issues", issueHandler.IssueRoutes())
			r.Mount("/feedback", feedbackHandler.FeedbackRoutes())
			r.Mount("/sessions", sessionHandler.SessionRoutes())
			r.Mount("/dashboard", dashboardHandler.Routes())
			r.Mount("/agents", agentHandler.Routes())
			r.Mount("/uploads", uploadHandler.Routes())
			r.Mount("/prompts", promptHandler.PromptRoutes())
			r.Mount("/activity-log", activityLogHandler.Routes())
			r.Mount("/plans", planHandler.Routes())
			r.Mount("/settings", settingsHandler.Routes())
			r.Mount("/client-instances", clientInstanceHandler.Routes())
			r.Get("/events/stream", eventsHandler.Stream)

			// Claude Code usage monitoring
			r.Get("/claude-usage/summary", claudeUsageHandler.GetSummary)
			r.Put("/claude-usage/config", claudeUsageHandler.UpdateConfig)
		}) // end protected group

		// Mode info — public, no auth required, served locally even in client mode.
		r.Get("/mode", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"mode":    cfg.Mode,
				"version": config.Version,
				"baseURL": cfg.BaseURL,
			})
		})
	})

	// Static file serving
	r.Handle("/uploads/*", http.StripPrefix("/uploads/", handlers.ServeWithDisposition("./uploads")))
	r.Handle("/docs/*", http.StripPrefix("/docs/", http.FileServer(http.Dir("./docs"))))
	r.Get("/skill.md", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./skill.md")
	})

	// SPA frontend — serve static assets, fall back to index.html for client-side routing
	frontendFS := http.Dir("./frontend/dist")
	r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// Try to serve the file as-is
		f, err := frontendFS.Open(req.URL.Path)
		if err == nil {
			f.Close()
			http.FileServer(frontendFS).ServeHTTP(w, req)
			return
		}
		// Fall back to index.html for SPA routing
		http.ServeFile(w, req, "./frontend/dist/index.html")
	}))

	// -------------------------------------------------------------------------
	// Background goroutines
	// -------------------------------------------------------------------------

	// GitHub comment sweeper
	if ghSweeper != nil {
		go func() {
			ticker := time.NewTicker(15 * time.Minute)
			defer ticker.Stop()
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

	// VIBECTL.md auto-regen
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		lastRegen := map[string]time.Time{}
		for range ticker.C {
			ctx := context.Background()
			settings, err := settingsService.Get(ctx)
			if err != nil || !settings.VibectlMdAutoRegen || settings.VibectlMdSchedule == "" {
				continue
			}
			projects, err := projectService.List(ctx)
			if err != nil {
				continue
			}
			now := time.Now().UTC()
			for _, p := range projects {
				if p.Archived {
					continue
				}
				last := lastRegen[p.ID.Hex()]
				var interval time.Duration
				switch settings.VibectlMdSchedule {
				case "hourly":
					interval = time.Hour
				case "daily":
					interval = 24 * time.Hour
				case "weekly":
					interval = 7 * 24 * time.Hour
				default:
					continue
				}
				if now.Sub(last) >= interval {
					vibectlMdService.UpdateSection(ctx, p.ID.Hex(), "status", "focus", "themes", "decisions")
					lastRegen[p.ID.Hex()] = now
				}
			}
		}
	}()

	// Health check recorder
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()

		runChecks := func() {
			ctx := context.Background()
			projects, err := projectService.List(ctx)
			if err != nil {
				return
			}
			for _, p := range projects {
				if p.HealthCheck == nil || p.HealthCheck.MonitorEnv == "" {
					continue
				}
				hcfg := p.HealthCheck
				var frontendURL, backendURL string
				if hcfg.MonitorEnv == "dev" {
					frontendURL = hcfg.Frontend.DevURL
					backendURL = hcfg.Backend.DevURL
				} else if hcfg.MonitorEnv == "prod" {
					frontendURL = hcfg.Frontend.ProdURL
					backendURL = hcfg.Backend.ProdURL
				}
				var results []models.HealthCheckResult
				if frontendURL != "" {
					results = append(results, healthCheckHandler.ProbeFrontend("Frontend", frontendURL))
				}
				if backendURL != "" {
					results = append(results, healthCheckHandler.Probe("Backend", backendURL))
				}
				if len(results) > 0 {
					prevRecord, _ := healthRecordService.GetLatest(ctx, p.ID)
					if err := healthRecordService.Insert(ctx, p.ID, results); err != nil {
						continue
					}
					if prevRecord != nil {
						prevStatusMap := map[string]string{}
						for _, r := range prevRecord.Results {
							prevStatusMap[r.Name] = r.Status
						}
						for _, newResult := range results {
							prevStatus := prevStatusMap[newResult.Name]
							isNowDown := newResult.Status == "down" || newResult.Status == "degraded"
							wasDown := prevStatus == "down" || prevStatus == "degraded"
							if prevStatus != "" && !wasDown && isNowDown {
								webhookService.Fire(ctx, p.ID, models.WebhookEventHealthDown, map[string]any{
									"service": newResult.Name, "status": newResult.Status, "url": newResult.URL,
								})
							} else if prevStatus != "" && wasDown && !isNowDown && newResult.Status == "up" {
								webhookService.Fire(ctx, p.ID, models.WebhookEventHealthUp, map[string]any{
									"service": newResult.Name, "status": newResult.Status, "url": newResult.URL,
								})
							}
						}
					}
				}
			}
		}

		time.Sleep(10 * time.Second)
		runChecks()
		for range ticker.C {
			runChecks()
		}
	}()

	// -------------------------------------------------------------------------
	// Start server
	// -------------------------------------------------------------------------
	srv := &http.Server{Addr: ":" + cfg.Port, Handler: r}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("shutting down server")
		chatManager.ShutdownAll()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		srv.Shutdown(shutdownCtx)
	}()

	activityLogService.LogAsync("backend_start", "VibeCtl server started on port "+cfg.Port+" (v"+config.Version+")", nil, "", nil)
	slog.Info("starting VibeCtl server", "port", cfg.Port, "githubOAuth", cfg.GitHubClientID != "")

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}

// runClientMode starts the server in client mode.
// There is no local MongoDB; all /api/v1/* requests are proxied to the
// configured remote standalone server.  WebSocket endpoints (/ws/*) are
// handled locally so terminals run on the developer's own machine.
// A small set of local-only endpoints are registered before the catch-all proxy:
//   - GET  /api/v1/mode           — returns mode info
//   - GET  /api/v1/local-paths    — per-project local path overrides (file-backed)
//   - PUT  /api/v1/local-paths/{id}
//   - DEL  /api/v1/local-paths/{id}
//   - POST /api/v1/admin/rebuild  — rebuild THIS binary (not the remote)
func runClientMode(cfg *config.Config) {
	if cfg.RemoteServerURL == "" {
		slog.Warn("client mode: REMOTE_SERVER_URL not set — serving setup page only")
	} else {
		slog.Info("client mode: proxying to remote server", "remoteURL", cfg.RemoteServerURL)
	}

	// Local event bus — receives events relayed from the remote server.
	localBus := events.NewBus()
	localEventsHandler := handlers.NewEventsHandler(localBus)

	// Start relay goroutine if remote is configured.
	stopRelay := make(chan struct{})
	if cfg.RemoteServerURL != "" && cfg.RemoteAPIKey != "" {
		go vibectlclient.StartEventRelay(cfg.RemoteServerURL, cfg.RemoteAPIKey, localBus, stopRelay)
	}
	_ = stopRelay // closed on process exit naturally

	// Local path store — persisted to ~/.vibectl-client/local_paths.json
	pathStore, err := vibectlclient.NewPathStore(cfg.LocalDataDir)
	if err != nil {
		slog.Error("client mode: failed to init path store", "error", err)
		os.Exit(1)
	}
	localPathsHandler := handlers.NewLocalPathsHandler(pathStore)

	// Local terminal manager — PTY processes run on this machine.
	termManager := terminal.NewManager()
	wsHandler := terminal.NewWebSocketHandler(termManager)

	// Shell WebSocket auth verifies tokens against the remote server.
	var shellWSHandler *terminal.ShellWebSocketHandler
	if cfg.RemoteServerURL != "" {
		remoteVerifier := vibectlclient.NewRemoteTokenVerifier(cfg.RemoteServerURL)
		shellWSHandler = terminal.NewShellWebSocketHandler(termManager, remoteVerifier)
	}

	// Build reverse proxy (nil when not yet configured).
	var proxy http.Handler
	if cfg.RemoteServerURL != "" {
		rp, err := vibectlclient.NewReverseProxy(cfg.RemoteServerURL, cfg.RemoteAPIKey)
		if err != nil {
			slog.Error("client mode: failed to create proxy", "error", err)
			os.Exit(1)
		}
		proxy = rp
	} else {
		// Not configured — return a helpful JSON error for all API calls.
		proxy = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "client not configured: set REMOTE_SERVER_URL and restart",
				"code":  "CLIENT_NOT_CONFIGURED",
			})
		})
	}

	r := chi.NewRouter()
	r.Use(middleware.Logging)
	r.Use(middleware.CORS(cfg.AllowedOrigins))

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok", "mode": "client"})
	})

	// Local WebSocket endpoints — terminals and chat run on this machine.
	r.Get("/ws/terminal", wsHandler.HandleConnection)
	if shellWSHandler != nil {
		r.Get("/ws/shell", shellWSHandler.HandleConnection)
	} else {
		r.Get("/ws/shell", func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "shell not available: REMOTE_SERVER_URL not configured", http.StatusServiceUnavailable)
		})
	}

	// Chat runs locally (claude binary on this machine) but persists to the remote server.
	remoteChatSession := vibectlclient.NewRemoteChatSessionService(cfg.RemoteServerURL, cfg.RemoteAPIKey)
	remoteChatHistory := vibectlclient.NewRemoteChatHistoryService(cfg.RemoteServerURL, cfg.RemoteAPIKey)
	localChatManager := terminal.NewChatManager(remoteChatSession, remoteChatHistory)
	localChatWSHandler := terminal.NewChatWebSocketHandler(localChatManager, nil)
	r.Get("/ws/chat", localChatWSHandler.HandleConnection)

	r.Route("/api/v1", func(r chi.Router) {
		// Mode info — always local, no auth.
		r.Get("/mode", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			resp := map[string]string{
				"mode":            "client",
				"version":         config.Version,
				"remoteServerURL": cfg.RemoteServerURL,
			}
			json.NewEncoder(w).Encode(resp)
		})

		// Local path overrides — no auth needed (local machine only).
		r.Mount("/local-paths", localPathsHandler.Routes())

		// Ping the remote server and report reachability — used by the UI status indicator.
		r.Get("/events/stream", localEventsHandler.Stream)
		r.Get("/client/ping", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if cfg.RemoteServerURL == "" {
				json.NewEncoder(w).Encode(map[string]interface{}{"reachable": false, "reason": "not configured"})
				return
			}
			pingClient := &http.Client{Timeout: 4 * time.Second}
			resp, err := pingClient.Get(cfg.RemoteServerURL + "/healthz")
			if err != nil {
				json.NewEncoder(w).Encode(map[string]interface{}{"reachable": false, "reason": err.Error()})
				return
			}
			resp.Body.Close()
			json.NewEncoder(w).Encode(map[string]interface{}{"reachable": resp.StatusCode < 500})
		})

		// Rebuild THIS binary — always local.
		serverSourceDir, _ := os.Getwd()
		adminHandler := handlers.NewAdminHandler(serverSourceDir, func() {}, nil)
		r.Post("/admin/rebuild", adminHandler.Rebuild)

		// GitHub OAuth not supported in client mode.
		r.Get("/auth/github", func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "GitHub OAuth not supported in client mode", http.StatusBadRequest)
		})
		r.Get("/auth/github/callback", func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "GitHub OAuth not supported in client mode", http.StatusBadRequest)
		})

		// Everything else → proxy to remote server.
		r.HandleFunc("/*", proxy.ServeHTTP)
	})

	// Static file serving.
	frontendFS := http.Dir("./frontend/dist")
	r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		f, err := frontendFS.Open(req.URL.Path)
		if err == nil {
			f.Close()
			http.FileServer(frontendFS).ServeHTTP(w, req)
			return
		}
		http.ServeFile(w, req, "./frontend/dist/index.html")
	}))

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: r}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("client mode: shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	slog.Info("starting VibeCtl client mode", "port", cfg.Port, "remote", cfg.RemoteServerURL)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("client mode server error", "error", err)
		os.Exit(1)
	}
}
