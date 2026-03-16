import { Routes, Route } from 'react-router-dom'
import RebuildOverlay from './components/shared/RebuildOverlay'
import Layout from './components/layout/Layout'
import { AuthProvider } from './contexts/AuthContext'
import AuthGate from './components/auth/AuthGate'
import Dashboard from './pages/Dashboard'
import ProjectPage from './pages/ProjectPage'
import IssuePage from './pages/IssuePage'
import IssueFormPage from './pages/IssueFormPage'
import FeedbackPage from './pages/FeedbackPage'
import ReviewPage from './pages/ReviewPage'
import PMReviewPage from './pages/PMReviewPage'
import ArchivedPage from './pages/ArchivedPage'
import PromptsPage from './pages/PromptsPage'
import ActivityLogPage from './pages/ActivityLogPage'
import MCPDocsPage from './pages/docs/MCPDocsPage'
import APIDocsPage from './pages/docs/APIDocsPage'
import CLIDocsPage from './pages/docs/CLIDocsPage'
import SettingsPage from './pages/SettingsPage'

function App() {
  return (
    <AuthProvider>
    <AuthGate>
    <>
    <RebuildOverlay />
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/archived" element={<ArchivedPage />} />
        <Route path="/projects/:code" element={<ProjectPage />} />
        <Route path="/projects/:code/issues/new" element={<IssueFormPage />} />
        <Route path="/projects/:code/issues/:issueKey" element={<IssuePage />} />
        <Route path="/projects/:code/pm-review" element={<PMReviewPage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/prompts" element={<PromptsPage />} />
        <Route path="/activity-log" element={<ActivityLogPage />} />
        <Route path="/docs/mcp" element={<MCPDocsPage />} />
        <Route path="/docs/api" element={<APIDocsPage />} />
        <Route path="/docs/cli" element={<CLIDocsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
    </>
    </AuthGate>
    </AuthProvider>
  )
}

export default App
