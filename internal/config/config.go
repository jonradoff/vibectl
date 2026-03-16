package config

import (
	"os"
	"strings"
)

// Version is set at build time via ldflags.
var Version = "0.8.0"

type Config struct {
	MongoDBURI     string
	DatabaseName   string
	Port           string
	AnthropicKey   string
	AllowedOrigins []string
	GitHubToken    string
}

func Load() *Config {
	return &Config{
		MongoDBURI:     getEnv("MONGODB_URI", "mongodb://localhost:27017"),
		DatabaseName:   getEnv("DATABASE_NAME", "vibectl"),
		Port:           getEnv("PORT", "4380"),
		AnthropicKey:   getEnv("ANTHROPIC_API_KEY", ""),
		AllowedOrigins: strings.Split(getEnv("ALLOWED_ORIGINS", "http://localhost:4370"), ","),
		GitHubToken:    getEnv("GITHUB_TOKEN", ""),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
