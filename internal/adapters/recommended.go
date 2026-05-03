package adapters

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// recommendedPlugins is the built-in list of plugins VibeCtl knows how to integrate with.
// These are surfaced to the user as recommended installs, with auto-detection of install state.
var recommendedPlugins = []RecommendedPlugin{
	{
		ID:          "token-optimizer@alexgreensh-token-optimizer",
		Name:        "Token Optimizer",
		Description: "Context window health monitoring, cost tracking, waste detection, and optimization. VibeCtl surfaces quality scores, session costs, and waste findings when installed.",
		InstallURL:  "https://github.com/alexgreensh/token-optimizer",
		Marketplace: "alexgreensh-token-optimizer",
		Features: []string{
			"Context health badge on project cards",
			"Cost-per-intent in Analytics",
			"Waste pattern warnings in project health",
			"Compaction alerts in Rounds",
			"Activity mode detection",
		},
	},
}

// GetRecommendedPlugins returns the list of recommended plugins with their
// current install/enabled state detected from the filesystem.
func GetRecommendedPlugins() []RecommendedPlugin {
	installed := getInstalledPluginIDs()
	enabled := getEnabledPluginIDs()

	result := make([]RecommendedPlugin, len(recommendedPlugins))
	for i, rp := range recommendedPlugins {
		result[i] = rp
		result[i].Installed = installed[rp.ID]
		result[i].Enabled = enabled[rp.ID]
	}
	return result
}

// IsRecommendedPlugin returns true if the given plugin ID is in the recommended list.
func IsRecommendedPlugin(id string) bool {
	for _, rp := range recommendedPlugins {
		if rp.ID == id {
			return true
		}
	}
	return false
}

func getInstalledPluginIDs() map[string]bool {
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".claude", "plugins", "installed_plugins.json"))
	if err != nil {
		return map[string]bool{}
	}
	var file struct {
		Plugins map[string]json.RawMessage `json:"plugins"`
	}
	if json.Unmarshal(data, &file) != nil {
		return map[string]bool{}
	}
	result := make(map[string]bool)
	for id := range file.Plugins {
		result[id] = true
		// Also match without marketplace suffix for flexible lookups
		if parts := strings.SplitN(id, "@", 2); len(parts) > 0 {
			result[parts[0]] = true
		}
	}
	return result
}

func getEnabledPluginIDs() map[string]bool {
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return map[string]bool{}
	}
	var settings struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	if json.Unmarshal(data, &settings) != nil {
		return map[string]bool{}
	}
	return settings.EnabledPlugins
}
