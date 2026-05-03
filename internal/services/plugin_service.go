package services

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// PluginCommand is a slash command registered by a plugin.
type PluginCommand struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"` // plugin name
}

// PluginSkill is a skill registered by a plugin.
type PluginSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Effort      string `json:"effort,omitempty"`
}

// InstalledPlugin represents a Claude Code plugin with its metadata.
type InstalledPlugin struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Author      string          `json:"author,omitempty"`
	Version     string          `json:"version"`
	Enabled     bool            `json:"enabled"`
	InstallPath string          `json:"installPath"`
	Commands    []PluginCommand `json:"commands"`
	Skills      []PluginSkill   `json:"skills"`
	Keywords    []string        `json:"keywords,omitempty"`
}

// AvailablePlugin is a plugin from the marketplace with install count.
type AvailablePlugin struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Marketplace   string `json:"marketplace"`
	UniqueInstalls int   `json:"uniqueInstalls"`
}

// Marketplace is a registered plugin marketplace.
type Marketplace struct {
	ID       string `json:"id"`
	Source   string `json:"source"`
	Repo     string `json:"repo"`
	Location string `json:"location,omitempty"`
}

// PluginService reads the Claude Code plugin filesystem.
type PluginService struct {
	claudeDir string
	mu        sync.Mutex
}

func NewPluginService() *PluginService {
	home, _ := os.UserHomeDir()
	return &PluginService{claudeDir: filepath.Join(home, ".claude")}
}

// ListInstalled returns all installed plugins with metadata, commands, and skills.
func (s *PluginService) ListInstalled() ([]InstalledPlugin, error) {
	installedPath := filepath.Join(s.claudeDir, "plugins", "installed_plugins.json")
	data, err := os.ReadFile(installedPath)
	if err != nil {
		return []InstalledPlugin{}, nil // no plugins installed
	}

	var file struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
			Version     string `json:"version"`
			Scope       string `json:"scope"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse installed_plugins.json: %w", err)
	}

	enabledMap := s.getEnabledMap()

	var result []InstalledPlugin
	for id, entries := range file.Plugins {
		if len(entries) == 0 {
			continue
		}
		entry := entries[0]

		plugin := InstalledPlugin{
			ID:          id,
			Name:        extractPluginName(id),
			Version:     entry.Version,
			InstallPath: entry.InstallPath,
			Enabled:     enabledMap[id],
		}

		// Read manifest
		manifestPath := filepath.Join(entry.InstallPath, ".claude-plugin", "plugin.json")
		if mData, err := os.ReadFile(manifestPath); err == nil {
			var manifest struct {
				Name        string `json:"name"`
				Description string `json:"description"`
				Author      struct {
					Name string `json:"name"`
				} `json:"author"`
				Keywords []string `json:"keywords"`
			}
			if json.Unmarshal(mData, &manifest) == nil {
				if manifest.Name != "" {
					plugin.Name = manifest.Name
				}
				plugin.Description = manifest.Description
				plugin.Author = manifest.Author.Name
				plugin.Keywords = manifest.Keywords
			}
		}

		// Scan commands
		cmdsDir := filepath.Join(entry.InstallPath, "commands")
		if entries, err := os.ReadDir(cmdsDir); err == nil {
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
					continue
				}
				cmdName := strings.TrimSuffix(e.Name(), ".md")
				desc := parseFrontmatterField(filepath.Join(cmdsDir, e.Name()), "description")
				plugin.Commands = append(plugin.Commands, PluginCommand{
					Name:        cmdName,
					Description: desc,
					Source:      plugin.Name,
				})
			}
		}

		// Scan skills
		skillsDir := filepath.Join(entry.InstallPath, "skills")
		if entries, err := os.ReadDir(skillsDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				skillMd := filepath.Join(skillsDir, e.Name(), "SKILL.md")
				if _, err := os.Stat(skillMd); err != nil {
					continue
				}
				name := parseFrontmatterField(skillMd, "name")
				if name == "" {
					name = e.Name()
				}
				plugin.Skills = append(plugin.Skills, PluginSkill{
					Name:        name,
					Description: parseFrontmatterField(skillMd, "description"),
					Effort:      parseFrontmatterField(skillMd, "effort"),
				})
			}
		}

		if plugin.Commands == nil {
			plugin.Commands = []PluginCommand{}
		}
		if plugin.Skills == nil {
			plugin.Skills = []PluginSkill{}
		}

		result = append(result, plugin)
	}
	return result, nil
}

// ListCommands returns all slash commands from enabled plugins.
func (s *PluginService) ListCommands() []PluginCommand {
	plugins, err := s.ListInstalled()
	if err != nil {
		return nil
	}
	var cmds []PluginCommand
	for _, p := range plugins {
		if !p.Enabled {
			continue
		}
		cmds = append(cmds, p.Commands...)
	}
	return cmds
}

// ListAvailable returns plugins from the install-counts cache.
func (s *PluginService) ListAvailable() ([]AvailablePlugin, error) {
	cachePath := filepath.Join(s.claudeDir, "plugins", "install-counts-cache.json")
	data, err := os.ReadFile(cachePath)
	if err != nil {
		return []AvailablePlugin{}, nil
	}

	var file struct {
		Counts []struct {
			Plugin         string `json:"plugin"`
			UniqueInstalls int    `json:"unique_installs"`
		} `json:"counts"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse install-counts-cache.json: %w", err)
	}

	var result []AvailablePlugin
	for _, c := range file.Counts {
		parts := strings.SplitN(c.Plugin, "@", 2)
		name := parts[0]
		marketplace := ""
		if len(parts) > 1 {
			marketplace = parts[1]
		}
		result = append(result, AvailablePlugin{
			ID:            c.Plugin,
			Name:          name,
			Marketplace:   marketplace,
			UniqueInstalls: c.UniqueInstalls,
		})
	}
	return result, nil
}

// ListMarketplaces returns registered marketplaces.
func (s *PluginService) ListMarketplaces() ([]Marketplace, error) {
	var result []Marketplace

	// Known marketplaces file
	knownPath := filepath.Join(s.claudeDir, "plugins", "known_marketplaces.json")
	if data, err := os.ReadFile(knownPath); err == nil {
		var known map[string]struct {
			Source struct {
				Source string `json:"source"`
				Repo   string `json:"repo"`
			} `json:"source"`
			InstallLocation string `json:"installLocation"`
		}
		if json.Unmarshal(data, &known) == nil {
			for id, m := range known {
				result = append(result, Marketplace{
					ID:       id,
					Source:   m.Source.Source,
					Repo:     m.Source.Repo,
					Location: m.InstallLocation,
				})
			}
		}
	}

	return result, nil
}

// SetEnabled enables or disables a plugin in settings.json.
func (s *PluginService) SetEnabled(pluginID string, enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	settingsPath := filepath.Join(s.claudeDir, "settings.json")
	data, _ := os.ReadFile(settingsPath)
	var settings map[string]interface{}
	if data != nil {
		json.Unmarshal(data, &settings)
	}
	if settings == nil {
		settings = make(map[string]interface{})
	}

	enabledPlugins, _ := settings["enabledPlugins"].(map[string]interface{})
	if enabledPlugins == nil {
		enabledPlugins = make(map[string]interface{})
	}
	enabledPlugins[pluginID] = enabled
	settings["enabledPlugins"] = enabledPlugins

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, out, 0644)
}

// AddMarketplace adds a marketplace to settings.json → extraKnownMarketplaces.
func (s *PluginService) AddMarketplace(id, repo string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	settingsPath := filepath.Join(s.claudeDir, "settings.json")
	data, _ := os.ReadFile(settingsPath)
	var settings map[string]interface{}
	if data != nil {
		json.Unmarshal(data, &settings)
	}
	if settings == nil {
		settings = make(map[string]interface{})
	}

	extra, _ := settings["extraKnownMarketplaces"].(map[string]interface{})
	if extra == nil {
		extra = make(map[string]interface{})
	}
	extra[id] = map[string]interface{}{
		"source": map[string]interface{}{
			"source": "github",
			"repo":   repo,
		},
	}
	settings["extraKnownMarketplaces"] = extra

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, out, 0644)
}

// InstallPlugin runs the claude CLI to install a plugin.
func (s *PluginService) InstallPlugin(marketplace, name string) error {
	cmd := exec.Command("claude", "plugins", "install", name, "--marketplace", marketplace)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("install failed: %s", string(out))
	}
	return nil
}

// UninstallPlugin runs the claude CLI to uninstall a plugin.
func (s *PluginService) UninstallPlugin(pluginID string) error {
	cmd := exec.Command("claude", "plugins", "uninstall", pluginID)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("uninstall failed: %s", string(out))
	}
	return nil
}

// --- helpers ---

func (s *PluginService) getEnabledMap() map[string]bool {
	settingsPath := filepath.Join(s.claudeDir, "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return map[string]bool{}
	}
	var settings struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	json.Unmarshal(data, &settings)
	if settings.EnabledPlugins == nil {
		return map[string]bool{}
	}
	return settings.EnabledPlugins
}

func extractPluginName(id string) string {
	parts := strings.SplitN(id, "@", 2)
	return parts[0]
}

// parseFrontmatterField reads a YAML frontmatter field from a markdown file.
func parseFrontmatterField(path, field string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	inFrontmatter := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "---" {
			if inFrontmatter {
				return "" // end of frontmatter, field not found
			}
			inFrontmatter = true
			continue
		}
		if inFrontmatter && strings.HasPrefix(line, field+":") {
			val := strings.TrimPrefix(line, field+":")
			return strings.TrimSpace(val)
		}
	}
	return ""
}
