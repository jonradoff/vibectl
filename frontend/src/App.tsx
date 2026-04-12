import { Routes, Route } from 'react-router-dom'
import RebuildOverlay from './components/shared/RebuildOverlay'
import Layout from './components/layout/Layout'
import { AuthProvider } from './contexts/AuthContext'
import { ModeProvider } from './contexts/ModeContext'
import { FaviconUpdater } from './components/shared/FaviconUpdater'
import AuthGate from './components/auth/AuthGate'
import AuthCallbackPage from './pages/AuthCallbackPage'
import Dashboard from './pages/Dashboard'
import IssuePage from './pages/IssuePage'
import IssueFormPage from './pages/IssueFormPage'
import FeedbackPage from './pages/FeedbackPage'
import ReviewPage from './pages/ReviewPage'
import PMReviewPage from './pages/PMReviewPage'
import ArchivedPage from './pages/ArchivedPage'
import PromptsPage from './pages/PromptsPage'
import ActivityLogPage from './pages/ActivityLogPage'
import PlansPage from './pages/PlansPage'
import MCPDocsPage from './pages/docs/MCPDocsPage'
import APIDocsPage from './pages/docs/APIDocsPage'
import CLIDocsPage from './pages/docs/CLIDocsPage'
import SettingsPage from './pages/SettingsPage'
import UsersPage from './pages/UsersPage'
import ProfilePage from './pages/ProfilePage'
// WorkspacePage moved to dashboard grid card

function App() {
  return (
    <ModeProvider>
    <FaviconUpdater />
    <AuthProvider>
      <RebuildOverlay />
      {/* OAuth callback — outside AuthGate so it works before auth is established */}
      <Routes>
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route
          path="/*"
          element={
            <AuthGate>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/archived" element={<ArchivedPage />} />
                  <Route path="/projects/:code/issues/new" element={<IssueFormPage />} />
                  <Route path="/projects/:code/issues/:issueKey" element={<IssuePage />} />
                  <Route path="/projects/:code/pm-review" element={<PMReviewPage />} />
                  <Route path="/feedback" element={<FeedbackPage />} />
                  <Route path="/review" element={<ReviewPage />} />
                  <Route path="/prompts" element={<PromptsPage />} />
                  <Route path="/activity-log" element={<ActivityLogPage />} />
                  <Route path="/plans" element={<PlansPage />} />
                  <Route path="/users" element={<UsersPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/docs/mcp" element={<MCPDocsPage />} />
                  <Route path="/docs/api" element={<APIDocsPage />} />
                  <Route path="/docs/cli" element={<CLIDocsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>
              </Routes>
            </AuthGate>
          }
        />
      </Routes>
    </AuthProvider>
    </ModeProvider>
  )
}

export default App
