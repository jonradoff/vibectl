function MCPDocsPage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">MCP Documentation</h1>
        <p className="text-gray-400 text-sm">Model Context Protocol server for AI coding agents · v0.8.0</p>
      </div>

      <Section title="Overview">
        <p>VibeCtl's MCP server provides 20 tools for AI agents (Claude Code, etc.) to manage projects, issues, sessions, health checks, and decisions — directly from the agent's context window without leaving the coding environment.</p>
        <p className="mt-2">The MCP server uses <strong>stdio transport</strong> (local only). It connects directly to MongoDB — no HTTP auth required.</p>
        <p className="mt-2 text-sm text-gray-500">
          Privacy Policy: <a href="https://www.metavert.io/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">metavert.io/privacy-policy</a>
        </p>
      </Section>

      <Section title="Setup">
        <p className="mb-3">Build the MCP binary:</p>
        <Code>make build-mcp{'\n'}# or: go build -o vibectl-mcp ./cmd/mcp/</Code>
        <p className="mt-4 mb-2">Add to <code className="text-indigo-300">~/.claude.json</code> (Claude Code user scope) or <code className="text-indigo-300">.mcp.json</code> (project scope):</p>
        <Code>{`{
  "mcpServers": {
    "vibectl": {
      "command": "/path/to/vibectl-mcp",
      "args": [
        "--mongodb-uri", "mongodb://localhost:27017",
        "--database", "vibectl"
      ]
    }
  }
}`}</Code>
        <p className="mt-4">For MongoDB Atlas, replace <code className="text-indigo-300">--mongodb-uri</code> with your Atlas connection string.</p>
        <p className="mt-2">Machine-readable version: <a href="/docs/mcp.md" target="_blank" className="text-indigo-400 hover:underline">docs/mcp.md</a></p>
      </Section>

      <Section title="Tools Reference">
        <ToolGroup name="Projects">
          <Tool name="list_projects" desc="List all active projects. Returns code, name, goals, deployment config." />
          <Tool name="get_project" desc="Get a project by code." params={[{ n: 'code', r: true, d: '3–5 uppercase letters (e.g. LCMS)' }]} />
          <Tool name="get_project_dashboard" desc="Issue counts by priority, status, and type." params={[{ n: 'projectCode', r: true }]} />
        </ToolGroup>

        <ToolGroup name="Issues">
          <Tool name="list_issues" desc="List issues with optional filters." params={[
            { n: 'projectCode', r: true },
            { n: 'priority', d: 'P0–P5' },
            { n: 'status', d: 'open, fixed, closed, etc.' },
            { n: 'type', d: 'bug, feature, idea' },
          ]} />
          <Tool name="get_issue" desc="Get issue by key." params={[{ n: 'issueKey', r: true, d: 'e.g. PROJ-0042' }]} />
          <Tool name="search_issues" desc="Full-text search across titles and descriptions." params={[
            { n: 'query', r: true },
            { n: 'projectCode', d: 'optional scope' },
          ]} />
          <Tool name="create_issue" desc="Create a new issue." params={[
            { n: 'projectCode', r: true },
            { n: 'title', r: true },
            { n: 'description', r: true },
            { n: 'type', r: true, d: 'bug / feature / idea' },
            { n: 'priority', r: true, d: 'P0–P5' },
            { n: 'reproSteps', d: 'required for bugs' },
            { n: 'source', d: 'e.g. user_report' },
            { n: 'createdBy' },
            { n: 'dueDate', d: 'RFC3339 or YYYY-MM-DD' },
          ]} />
          <Tool name="update_issue" desc="Update title, description, priority, source, dueDate, or reproSteps." params={[
            { n: 'issueKey', r: true },
            { n: 'title/description/priority/source/dueDate/reproSteps', d: 'any subset' },
          ]} />
          <Tool name="update_issue_status" desc="Transition to new status (validated by type)." params={[
            { n: 'issueKey', r: true },
            { n: 'newStatus', r: true },
          ]} />
          <Tool name="get_open_p0_issues" desc="Get all open P0 critical issues." params={[
            { n: 'projectCode', d: 'optional, omit for all projects' },
          ]} />
        </ToolGroup>

        <ToolGroup name="Project Context">
          <Tool name="get_vibectl_md" desc="Get VIBECTL.md — full project status, goals, deployment, decisions." params={[{ n: 'projectCode', r: true }]} />
          <Tool name="regenerate_vibectl_md" desc="Regenerate and write VIBECTL.md to the project's local path." params={[{ n: 'projectCode', r: true }]} />
          <Tool name="get_decisions" desc="Get audit log of recent decisions." params={[
            { n: 'projectCode', r: true },
            { n: 'limit', d: 'default 20' },
          ]} />
          <Tool name="record_decision" desc="Log a significant decision made during development." params={[
            { n: 'projectCode', r: true },
            { n: 'summary', r: true },
            { n: 'issueKey', d: 'related issue' },
          ]} />
          <Tool name="get_deployment_info" desc="Get deployment config and health check settings." params={[{ n: 'projectCode', r: true }]} />
        </ToolGroup>

        <ToolGroup name="Health">
          <Tool name="get_health_status" desc="Get 24-hour uptime history for a project's health check endpoints." params={[{ n: 'projectCode', r: true }]} />
        </ToolGroup>

        <ToolGroup name="Sessions">
          <Tool name="list_sessions" desc="List recent work sessions." params={[
            { n: 'projectCode', r: true },
            { n: 'limit', d: 'default 10' },
          ]} />
          <Tool name="get_latest_session" desc="Get the most recent work session." params={[{ n: 'projectCode', r: true }]} />
        </ToolGroup>

        <ToolGroup name="Prompts">
          <Tool name="list_prompts" desc="List saved prompts (project + global)." params={[
            { n: 'projectCode', d: 'optional' },
          ]} />
          <Tool name="get_prompt" desc="Get a saved prompt by ID." params={[{ n: 'promptId', r: true }]} />
        </ToolGroup>
      </Section>

      <Section title="Workflow Patterns">
        <p className="font-medium text-gray-200 mb-2">Before starting work:</p>
        <Code>{`get_vibectl_md(projectCode)          // read full status
list_issues(projectCode, priority=P0) // critical issues
get_latest_session(projectCode)       // what was last worked on`}</Code>
        <p className="font-medium text-gray-200 mt-4 mb-2">After completing a task:</p>
        <Code>{`update_issue_status(issueKey, "fixed")
record_decision(projectCode, "...")
regenerate_vibectl_md(projectCode)`}</Code>
      </Section>
    </div>
  );
}

// --- Helpers ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3 border-b border-gray-800 pb-2">{title}</h2>
      <div className="text-gray-300 text-sm space-y-1">{children}</div>
    </section>
  );
}

function ToolGroup({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">{name}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Tool({ name, desc, params }: {
  name: string;
  desc: string;
  params?: { n: string; r?: boolean; d?: string }[];
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
      <div className="flex items-start gap-2 mb-1">
        <code className="text-indigo-400 text-sm font-mono font-medium">{name}</code>
      </div>
      <p className="text-gray-400 text-xs mb-2">{desc}</p>
      {params && params.length > 0 && (
        <div className="grid grid-cols-1 gap-1">
          {params.map((p) => (
            <div key={p.n} className="flex items-start gap-2 text-xs">
              <code className="text-gray-300 font-mono shrink-0">{p.n}</code>
              {p.r && <span className="text-red-400 shrink-0">*</span>}
              {p.d && <span className="text-gray-500">{p.d}</span>}
            </div>
          ))}
        </div>
      )}
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

export default MCPDocsPage;
