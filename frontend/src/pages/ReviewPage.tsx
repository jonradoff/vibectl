import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listProjects } from '../api/client';
import type { Project } from '../types';

const cannedPrompts = [
  'Review all open issues and give recommendations',
  'Work on all P0 issues',
  'Summarize the current state of this project',
  'Suggest what to work on next based on priorities',
];

export default function ReviewPage() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  const project: Project | undefined = projects[currentIndex];

  function copyPrompt(prompt: string, projectName: string) {
    const fullPrompt = `[${projectName}] ${prompt}`;
    navigator.clipboard.writeText(fullPrompt).then(() => {
      setToast('Copied to clipboard');
      setTimeout(() => setToast(null), 2000);
    });
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <p className="text-gray-400">Loading projects...</p>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold mb-6">Review</h1>
          <div className="bg-gray-800 rounded-lg p-12 text-center">
            <p className="text-gray-400 text-lg">No projects to review</p>
            <p className="text-gray-500 text-sm mt-2">
              Create a project first to begin reviewing.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Review</h1>

        {/* Progress indicator */}
        <div className="flex items-center justify-between mb-6">
          <p className="text-gray-400 text-sm">
            Project {currentIndex + 1} of {projects.length}
          </p>
          <div className="flex gap-1">
            {projects.map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full ${
                  i === currentIndex ? 'bg-blue-500' : 'bg-gray-700'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Project card */}
        {project && (
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-semibold">{project.name}</h2>
                <span className="inline-block mt-1 px-2 py-0.5 bg-gray-700 text-gray-300 rounded text-xs font-mono">
                  {project.code}
                </span>
              </div>
              <Link
                to={`/projects/${project.code}`}
                className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
              >
                View full project &rarr;
              </Link>
            </div>

            {project.description && (
              <p className="text-gray-300 mb-4">{project.description}</p>
            )}

            {project.goals && project.goals.length > 0 && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-gray-400 mb-2">Goals</h3>
                <ul className="space-y-1">
                  {project.goals.map((goal, i) => (
                    <li key={i} className="text-gray-300 text-sm flex items-start gap-2">
                      <span className="text-gray-500 mt-0.5">-</span>
                      {goal}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Canned prompts */}
        {project && (
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Quick Prompts</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {cannedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => copyPrompt(prompt, project.name)}
                  className="text-left px-4 py-3 bg-gray-900 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-200 transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            &larr; Previous
          </button>
          <button
            onClick={() => setCurrentIndex((i) => Math.min(projects.length - 1, i + 1))}
            disabled={currentIndex === projects.length - 1}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next &rarr;
          </button>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-2 bg-green-600 text-white text-sm rounded-lg shadow-lg animate-fade-in">
          {toast}
        </div>
      )}
    </div>
  );
}
