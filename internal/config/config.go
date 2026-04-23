package config

import (
	"os"
	"strings"
)

// Version is set at build time via ldflags.
var Version = "0.12.4"

type Config struct {
	MongoDBURI           string
	DatabaseName         string
	Port                 string
	AnthropicKey         string
	AllowedOrigins       []string
	GitHubToken          string
	GitHubClientID       string
	GitHubClientSecret   string
	BaseURL              string // e.g. http://localhost:4380
	APIKeyEncryptionKey  string // 32-char key for AES-256-GCM encryption of stored API keys
	ReposDir             string // directory where repos are cloned, default /data/repos

	// Client mode fields
	// Mode is "standalone" (default) or "client".
	// In standalone mode, the server owns its MongoDB and serves all data locally.
	// In client mode, there is no local MongoDB; API requests are proxied to a remote
	// standalone server while terminals run locally.
	Mode            string
	RemoteServerURL string // client mode: URL of the remote vibectl server (no trailing slash)
	RemoteAPIKey    string // client mode: API key for machine-to-machine ops
	LocalDataDir    string // client mode: directory for local config/data
}

func Load() *Config {
	mode := getEnv("VIBECTL_MODE", "standalone")

	// In client mode, default to a different port so standalone and client
	// instances can coexist on the same machine without port conflicts.
	portDefault := "4380"
	if mode == "client" {
		portDefault = "4385"
	}

	localDataDir := getEnv("LOCAL_DATA_DIR", "")
	if localDataDir == "" {
		home, _ := os.UserHomeDir()
		if home != "" {
			localDataDir = home + "/.vibectl-client"
		} else {
			localDataDir = ".vibectl-client"
		}
	}

	return &Config{
		MongoDBURI:          getEnv("MONGODB_URI", "mongodb://localhost:27017"),
		DatabaseName:        getEnv("DATABASE_NAME", "vibectl"),
		Port:                getEnv("PORT", portDefault),
		AnthropicKey:        getEnv("ANTHROPIC_API_KEY", ""),
		AllowedOrigins:      strings.Split(getEnv("ALLOWED_ORIGINS", "http://localhost:4370"), ","),
		GitHubToken:         getEnv("GITHUB_TOKEN", ""),
		GitHubClientID:      getEnv("GITHUB_CLIENT_ID", ""),
		GitHubClientSecret:  getEnv("GITHUB_CLIENT_SECRET", ""),
		BaseURL:             getEnv("BASE_URL", "http://localhost:4380"),
		APIKeyEncryptionKey: getEnv("API_KEY_ENCRYPTION_KEY", ""),
		ReposDir:            getEnv("REPOS_DIR", "/data/repos"),
		Mode:                mode,
		RemoteServerURL:     getEnv("REMOTE_SERVER_URL", ""),
		RemoteAPIKey:        getEnv("REMOTE_API_KEY", ""),
		LocalDataDir:        localDataDir,
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
