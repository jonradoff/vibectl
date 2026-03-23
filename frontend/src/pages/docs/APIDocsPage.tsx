function APIDocsPage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">API Documentation</h1>
        <p className="text-gray-400 text-sm">VibeCtl REST API · v0.8.0 · Base URL: <code className="text-indigo-300">http://localhost:4380</code></p>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4 text-sm text-gray-300">
        <p><strong className="text-white">Auth:</strong> Protected endpoints require <code className="text-indigo-300">Authorization: Bearer &lt;token&gt;</code>. Get a token via <code className="text-indigo-300">POST /api/v1/admin/login</code>. When no admin password is set, all endpoints are open.</p>
        <p className="mt-1"><strong className="text-white">Errors:</strong> <code className="text-indigo-300">{"{ \"error\": \"message\", \"code\": \"ERROR_CODE\" }"}</code></p>
        <p className="mt-2">Machine-readable version: <a href="/docs/api.md" target="_blank" className="text-indigo-400 hover:underline">docs/api.md</a></p>
      </div>

      <EndpointGroup name="Health">
        <Endpoint method="GET" path="/healthz" desc="Server health: status, version, uptime, MongoDB status, KPIs (project count, open issues)." />
      </EndpointGroup>

      <EndpointGroup name="Admin">
        <Endpoint method="POST" path="/api/v1/admin/login" desc="Authenticate with admin password. Returns session token." body='{ "password": "string" }' response='{ "token": "hex64string" }' />
        <Endpoint method="POST" path="/api/v1/admin/set-password" desc="Set or change admin password. currentPassword may be empty on first run." body='{ "currentPassword": "...", "newPassword": "..." }' response='{ "status": "ok", "token": "..." }' />
        <Endpoint method="POST" path="/api/v1/admin/rebuild" auth desc="Rebuild + restart server. Broadcasts WS event, runs go build, syscall.Exec." response='{ "status": "restarting" }' />
        <Endpoint method="GET" path="/api/v1/admin/self-info" desc="Server source directory." />
      </EndpointGroup>

      <EndpointGroup name="Projects">
        <Endpoint method="GET" path="/api/v1/projects" desc="List all active projects." />
        <Endpoint method="POST" path="/api/v1/projects" desc="Create project." body='{ "name", "code" (3-5 chars), "description", "links": { "localPath", "githubUrl" }, "goals": [] }' />
        <Endpoint method="GET" path="/api/v1/projects/archived" desc="List archived projects." />
        <Endpoint method="GET" path="/api/v1/projects/code/{code}" desc="Get project by code (e.g. MYAPP)." />
        <Endpoint method="GET" path="/api/v1/projects/{id}" desc="Get project by ObjectID." />
        <Endpoint method="PUT" path="/api/v1/projects/{id}" desc="Update project fields." />
        <Endpoint method="DELETE" path="/api/v1/projects/{id}" desc="Delete project." />
        <Endpoint method="POST" path="/api/v1/projects/{id}/archive" desc="Archive project." />
        <Endpoint method="POST" path="/api/v1/projects/{id}/unarchive" desc="Unarchive project." />
        <Endpoint method="GET" path="/api/v1/projects/{id}/dashboard" desc="Project summary: open issue count, issues by priority/status/type." />
        <Endpoint method="GET" path="/api/v1/projects/{id}/healthcheck" desc="Run live health check for project's configured endpoints." />
        <Endpoint method="GET" path="/api/v1/projects/{id}/healthcheck/history" desc="Health records for the last 24 hours." />
        <Endpoint method="POST" path="/api/v1/projects/{id}/vibectl-md/generate" desc="Regenerate and write VIBECTL.md to project's local path." />
        <Endpoint method="GET" path="/api/v1/projects/{id}/vibectl-md" desc="Get current VIBECTL.md content." />
        <Endpoint method="GET" path="/api/v1/projects/{id}/decisions" desc="Recent decisions. Query: ?limit=N" />
        <Endpoint method="GET" path="/api/v1/projects/{id}/chat-history" desc="Claude Code chat sessions for a project." />
      </EndpointGroup>

      <EndpointGroup name="Issues">
        <Endpoint method="GET" path="/api/v1/projects/{id}/issues" desc="List issues. Query: ?priority=P0&status=open&type=bug" />
        <Endpoint method="POST" path="/api/v1/projects/{id}/issues" desc="Create issue." body='{ "title", "type": "bug|feature|idea", "priority": "P0–P5", "description", "reproSteps", "source", "createdBy", "dueDate" }' />
        <Endpoint method="GET" path="/api/v1/projects/{id}/issues/archived" desc="List archived issues." />
        <Endpoint method="GET" path="/api/v1/issues/{issueKey}" desc="Get issue by key (e.g. MYAPP-0042)." />
        <Endpoint method="PUT" path="/api/v1/issues/{issueKey}" desc="Update issue fields." />
        <Endpoint method="PATCH" path="/api/v1/issues/{issueKey}/status" desc="Transition status (validated by type)." body='{ "status": "fixed" }' />
        <Endpoint method="DELETE" path="/api/v1/issues/{issueKey}" desc="Soft-delete (archive) issue." />
        <Endpoint method="POST" path="/api/v1/issues/{issueKey}/restore" desc="Restore archived issue." />
        <Endpoint method="GET" path="/api/v1/issues/search" desc="Full-text search. Query: ?q=search+text" />
      </EndpointGroup>

      <EndpointGroup name="Feedback">
        <Endpoint method="GET" path="/api/v1/feedback" desc="List feedback. Query: ?triageStatus=pending&projectId=ID&sourceType=manual" />
        <Endpoint method="POST" path="/api/v1/feedback" desc="Submit feedback." body='{ "projectId", "rawContent", "sourceType": "manual|github_comment|api", "submittedBy", "sourceUrl" }' />
        <Endpoint method="POST" path="/api/v1/feedback/batch" desc="Submit multiple feedback items." />
        <Endpoint method="GET" path="/api/v1/projects/{id}/feedback" desc="Feedback for a project." />
        <Endpoint method="POST" path="/api/v1/feedback/{id}/triage" desc="Trigger AI triage for one feedback item." />
        <Endpoint method="POST" path="/api/v1/projects/{id}/feedback/triage-all" desc="Triage all pending feedback for a project." />
        <Endpoint method="POST" path="/api/v1/feedback/{id}/review" desc="Accept or dismiss." body='{ "status": "accepted|dismissed" }' />
      </EndpointGroup>

      <EndpointGroup name="Sessions">
        <Endpoint method="GET" path="/api/v1/projects/{id}/sessions" desc="List work sessions for a project." />
        <Endpoint method="POST" path="/api/v1/projects/{id}/sessions" desc="Create session." body='{ "summary", "issuesWorkedOn": ["KEY-001"] }' />
        <Endpoint method="GET" path="/api/v1/sessions/{id}" desc="Get session by ID." />
        <Endpoint method="PUT" path="/api/v1/sessions/{id}" desc="Update session." />
      </EndpointGroup>

      <EndpointGroup name="Prompts">
        <Endpoint method="GET" path="/api/v1/prompts" desc="List all global prompts." />
        <Endpoint method="POST" path="/api/v1/prompts" desc="Create global prompt." body='{ "name", "body" }' />
        <Endpoint method="GET" path="/api/v1/prompts/{id}" desc="Get prompt by ID." />
        <Endpoint method="PUT" path="/api/v1/prompts/{id}" desc="Update prompt." />
        <Endpoint method="DELETE" path="/api/v1/prompts/{id}" desc="Delete prompt." />
        <Endpoint method="GET" path="/api/v1/projects/{id}/prompts" desc="Prompts for a project (includes global)." />
        <Endpoint method="POST" path="/api/v1/projects/{id}/prompts" desc="Create project-scoped prompt." />
      </EndpointGroup>

      <EndpointGroup name="Dashboard & Activity">
        <Endpoint method="GET" path="/api/v1/dashboard" desc="Global stats: projects, open issues, pending feedback, per-project summaries." />
        <Endpoint method="GET" path="/api/v1/activity-log" desc="Recent activity. Query: ?projectId=ID&limit=50&offset=0" />
      </EndpointGroup>

      <EndpointGroup name="WebSockets">
        <Endpoint method="WS" path="/ws/terminal" desc="PTY terminal session (xterm.js)." />
        <Endpoint method="WS" path="/ws/chat" desc="Claude Code stream-json chat session." />
      </EndpointGroup>

      <EndpointGroup name="Issue Comments">
        <Endpoint method="GET" path="/api/v1/issues/{issueKey}/comments" desc="List all comments for an issue, sorted by creation time ascending." />
        <Endpoint method="POST" path="/api/v1/issues/{issueKey}/comments" desc="Add a comment to an issue." body='{ "body": "string", "author": "string" }' />
        <Endpoint method="DELETE" path="/api/v1/issues/{issueKey}/comments/{commentId}" desc="Delete a comment by ID." />
      </EndpointGroup>

      <EndpointGroup name="Settings">
        <Endpoint method="GET" path="/api/v1/settings" desc="Get application-wide settings (VIBECTL.md auto-regen schedule, etc.)." />
        <Endpoint method="PUT" path="/api/v1/settings" desc="Update application settings." body='{ "vibectlMdAutoRegen": bool, "vibectlMdSchedule": "hourly|daily|weekly" }' />
      </EndpointGroup>

      <EndpointGroup name="Webhooks">
        <Endpoint
          method="PUT"
          path="/api/v1/projects/{id}"
          desc="Register webhooks by including a webhooks array in the project update payload. Each webhook has: url, events[], and optional secret for HMAC-SHA256 verification."
          body='{ "webhooks": [{ "url": "https://...", "events": ["p0_issue_created", "health_check_down", "health_check_up", "feedback_triaged"], "secret": "optional" }] }'
        />
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 text-xs text-gray-400 space-y-1">
          <p><strong className="text-gray-300">Payload:</strong> <code>{"{ event, projectId, timestamp, data }"}</code></p>
          <p><strong className="text-gray-300">Signature:</strong> When a secret is set, <code>X-Vibectl-Signature: sha256=&lt;hex&gt;</code> is included (HMAC-SHA256 over raw body).</p>
          <p><strong className="text-gray-300">Events:</strong> <code>p0_issue_created</code>, <code>health_check_down</code>, <code>health_check_up</code>, <code>feedback_triaged</code></p>
        </div>
      </EndpointGroup>
    </div>
  );
}

function EndpointGroup({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3 border-b border-gray-800 pb-2">{name}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

const methodColors: Record<string, string> = {
  GET: 'bg-blue-600/20 text-blue-400',
  POST: 'bg-green-600/20 text-green-400',
  PUT: 'bg-yellow-600/20 text-yellow-400',
  PATCH: 'bg-orange-600/20 text-orange-400',
  DELETE: 'bg-red-600/20 text-red-400',
  WS: 'bg-purple-600/20 text-purple-400',
};

function Endpoint({ method, path, desc, body, response, auth }: {
  method: string; path: string; desc: string;
  body?: string; response?: string; auth?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-xs font-mono font-bold px-1.5 py-0.5 rounded ${methodColors[method] || 'bg-gray-700 text-gray-300'}`}>{method}</span>
        <code className="text-sm text-gray-200 font-mono">{path}</code>
        {auth && <span className="text-xs text-amber-400 ml-1">🔒 auth</span>}
      </div>
      <p className="text-gray-400 text-xs">{desc}</p>
      {body && (
        <p className="text-xs text-gray-500 mt-1"><span className="text-gray-400">Body:</span> <code>{body}</code></p>
      )}
      {response && (
        <p className="text-xs text-gray-500 mt-0.5"><span className="text-gray-400">Returns:</span> <code>{response}</code></p>
      )}
    </div>
  );
}

export default APIDocsPage;
