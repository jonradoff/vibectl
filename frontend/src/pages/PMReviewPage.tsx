import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getProjectByCode, runPMReview } from '../api/client';
import type { PMReviewResult } from '../types';

export default function PMReviewPage() {
  const { code } = useParams<{ code: string }>();
  const [result, setResult] = useState<PMReviewResult | null>(null);

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', code],
    queryFn: () => getProjectByCode(code!),
    enabled: !!code,
  });

  const reviewMutation = useMutation({
    mutationFn: (projectId: string) => runPMReview(projectId),
    onSuccess: (data) => setResult(data),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">PM Review</h1>
        {project && (
          <p className="text-gray-400 mb-6">
            {project.name}{' '}
            <span className="font-mono text-xs bg-gray-800 px-2 py-0.5 rounded">
              {project.code}
            </span>
          </p>
        )}

        {/* Run button */}
        <div className="mb-8">
          <button
            onClick={() => project && reviewMutation.mutate(project.id)}
            disabled={reviewMutation.isPending || !project}
            className="px-5 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 font-medium disabled:opacity-50"
          >
            {reviewMutation.isPending ? 'Running Review...' : 'Run PM Review'}
          </button>
          {reviewMutation.isError && (
            <p className="mt-2 text-sm text-red-400">
              {(reviewMutation.error as Error).message}
            </p>
          )}
        </div>

        {/* Result */}
        {result ? (
          <div className="space-y-6">
            {/* Goal Assessments */}
            {result.goalAssessments.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Goal Assessments</h2>
                <div className="space-y-3">
                  {result.goalAssessments.map((ga, i) => (
                    <div key={i} className="bg-gray-800 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-white">{ga.goal}</span>
                        <span className={`text-sm font-mono ${
                          ga.coverage >= 0.7 ? 'text-green-400' :
                          ga.coverage >= 0.4 ? 'text-yellow-400' : 'text-red-400'
                        }`}>
                          {(ga.coverage * 100).toFixed(0)}% covered
                        </span>
                      </div>
                      <p className="text-sm text-gray-300">{ga.assessment}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Gaps */}
            {result.gaps.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Gaps</h2>
                <div className="space-y-3">
                  {result.gaps.map((gap, i) => (
                    <div key={i} className="bg-gray-800 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-white">{gap.description}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          gap.severity === 'high' ? 'bg-red-600 text-white' :
                          gap.severity === 'medium' ? 'bg-yellow-600 text-white' : 'bg-gray-600 text-white'
                        }`}>
                          {gap.severity}
                        </span>
                      </div>
                      <p className="text-sm text-gray-300">{gap.suggestion}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Risks */}
            {result.risks.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Risks</h2>
                <div className="space-y-3">
                  {result.risks.map((risk, i) => (
                    <div key={i} className="bg-gray-800 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-white">{risk.description}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          risk.likelihood === 'high' ? 'bg-red-600 text-white' :
                          risk.likelihood === 'medium' ? 'bg-yellow-600 text-white' : 'bg-gray-600 text-white'
                        }`}>
                          {risk.likelihood}
                        </span>
                      </div>
                      <p className="text-sm text-gray-300">{risk.mitigation}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Priority Changes */}
            {result.priorityChanges.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Priority Adjustments</h2>
                <div className="space-y-2">
                  {result.priorityChanges.map((pc, i) => (
                    <div key={i} className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
                      <div>
                        <span className="font-mono text-sm text-blue-300">{pc.issueKey}</span>
                        <span className="text-gray-400 mx-2">{pc.currentPriority}</span>
                        <span className="text-gray-500 mx-1">&rarr;</span>
                        <span className="text-white mx-2">{pc.suggestedPriority}</span>
                      </div>
                      <p className="text-sm text-gray-400">{pc.reason}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Summary */}
            <div>
              <h2 className="text-lg font-semibold mb-3">Summary</h2>
              <div className="bg-gray-800 rounded-lg p-4 text-gray-300 whitespace-pre-wrap">
                {result.summary}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg p-12 text-center">
            <div className="text-gray-500 mb-3">
              <svg
                className="w-12 h-12 mx-auto"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
            <p className="text-gray-400 text-lg">No reviews yet</p>
            <p className="text-gray-500 text-sm mt-2">
              Run a PM review to analyze gaps between project goals and current issues.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
