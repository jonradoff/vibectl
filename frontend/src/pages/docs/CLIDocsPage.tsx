function CLIDocsPage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">CLI Documentation</h1>
        <p className="text-gray-400 text-sm">vibectl command-line tool · v0.8.0</p>
      </div>

      <Section title="Overview">
        <p>The <code className="text-indigo-300">vibectl</code> CLI provides terminal-native access to all VibeCtl features. Use it for scripting, CI/CD automation, or quick operations without opening the web UI.</p>
        <p className="mt-2">Machine-readable version: <a href="/docs/cli.md" target="_blank" className="text-indigo-400 hover:underline">docs/cli.md</a></p>
      </Section>

      <Section title="Installation">
        <Code>make build-cli{'\n'}# Binary at: ./cli/vibectl</Code>
      </Section>

      <Section title="Environment Variables">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">Variable</th>
              <th className="pb-2 pr-4">Default</th>
              <th className="pb-2">Description</th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            <tr className="border-b border-gray-800/50">
              <td className="py-2 pr-4 font-mono text-indigo-300">VIBECTL_URL</td>
              <td className="py-2 pr-4 text-gray-500">http://localhost:4380</td>
              <td className="py-2">Server base URL</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono text-indigo-300">VIBECTL_TOKEN</td>
              <td className="py-2 pr-4 text-gray-500">~/.vibectl/token</td>
              <td className="py-2">Bearer auth token (overrides saved token)</td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title="Global Flags">
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
          <code className="text-indigo-300 font-mono">--format json</code>
          <span className="text-gray-400 ml-3 text-sm">Output raw JSON instead of formatted tables</span>
        </div>
      </Section>

      <Section title="Commands">
        <CmdGroup name="admin">
          <Cmd syntax="vibectl admin login" desc="Prompt for password, authenticate, save token to ~/.vibectl/token" />
          <Cmd syntax="vibectl admin set-password" desc="Set or change the admin password (min 8 characters). On first run, leave current password blank." />
          <Cmd syntax="vibectl admin logout" desc="Remove saved auth token" />
        </CmdGroup>

        <CmdGroup name="projects">
          <Cmd syntax="vibectl projects list" desc="List all active projects" />
          <Cmd syntax="vibectl projects create --name NAME --code CODE [--description DESC] [--local-path PATH] [--github-url URL]" desc="Create a project. Code must be 3–5 uppercase letters." />
        </CmdGroup>

        <CmdGroup name="issues">
          <Cmd syntax="vibectl issues list CODE [--priority P0] [--status open] [--type bug]" desc="List issues with optional filters" />
          <Cmd syntax='vibectl issues create CODE --title TITLE --type TYPE --priority PRI [--description DESC] [--repro-steps STEPS] [--source SRC] [--created-by USER]' desc="Create a new issue. --repro-steps required for bugs." />
          <Cmd syntax="vibectl issues view ISSUE-KEY" desc="Show full issue details (e.g. MYAPP-0042)" />
          <Cmd syntax="vibectl issues status ISSUE-KEY NEW_STATUS" desc="Transition issue status (validated by type)" />
          <Cmd syntax='vibectl issues search "query text"' desc="Full-text search across all issue titles and descriptions" />
          <div className="ml-4 mt-2 text-xs text-gray-500 space-y-1">
            <p><strong className="text-gray-400">Bug:</strong> open → fixed | cannot_reproduce → closed</p>
            <p><strong className="text-gray-400">Feature:</strong> open → approved | backlogged → implemented → closed</p>
            <p><strong className="text-gray-400">Idea:</strong> open → closed | backlogged</p>
          </div>
        </CmdGroup>

        <CmdGroup name="feedback">
          <Cmd syntax='vibectl feedback submit CODE --content "text" [--source-type manual] [--submitted-by NAME]' desc="Submit user feedback for a project" />
          <Cmd syntax="vibectl feedback triage [--pending]" desc="List feedback items, optionally filtering to pending-only" />
        </CmdGroup>

        <CmdGroup name="health">
          <Cmd syntax="vibectl health CODE" desc="Run health check and show current status for all configured endpoints" />
          <Cmd syntax="vibectl health history CODE" desc="Show 24-hour uptime history" />
        </CmdGroup>

        <CmdGroup name="sessions">
          <Cmd syntax="vibectl sessions CODE [--limit N]" desc="List recent work sessions for a project" />
        </CmdGroup>

        <CmdGroup name="prompts">
          <Cmd syntax="vibectl prompts list [CODE]" desc="List prompts — for a project (includes global) or global-only" />
          <Cmd syntax="vibectl prompts get PROMPT-ID" desc="Show prompt name and body" />
        </CmdGroup>

        <CmdGroup name="other">
          <Cmd syntax="vibectl dashboard" desc="Print global dashboard: projects, open issues, pending feedback" />
          <Cmd syntax="vibectl decisions CODE [--limit N]" desc="List recent decisions for a project" />
          <Cmd syntax="vibectl generate-md CODE" desc="Generate VIBECTL.md for a project" />
          <Cmd syntax="vibectl generate-md --all" desc="Generate VIBECTL.md for all projects" />
        </CmdGroup>
      </Section>

      <Section title="Scripting Examples">
        <Code>{`# Get open P0 issues as JSON
vibectl issues list MYAPP --priority P0 --status open --format json | jq '.[].issueKey'

# Create issue from CI
vibectl issues create MYAPP \\
  --title "Deploy failed: DB migration error" \\
  --type bug --priority P0 \\
  --source ci --format json | jq -r .issueKey

# Check health in monitoring
STATUS=$(vibectl health MYAPP --format json | jq -r '.[0].status')
[ "$STATUS" = "up" ] || alert "Backend health: $STATUS"`}
        </Code>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3 border-b border-gray-800 pb-2">{title}</h2>
      <div className="text-gray-300 text-sm space-y-1">{children}</div>
    </section>
  );
}

function CmdGroup({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">{name}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Cmd({ syntax, desc }: { syntax: string; desc: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
      <code className="text-indigo-300 text-xs font-mono block mb-1">{syntax}</code>
      <p className="text-gray-400 text-xs">{desc}</p>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-300 font-mono overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

export default CLIDocsPage;
