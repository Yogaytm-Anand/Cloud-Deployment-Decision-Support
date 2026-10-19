// src/services/api.js
//
// Exact backend response shapes (from server.js):
//
// POST /api/analyze ->
//   { success, jobId, repository, validation: { dockerfile },
//     dockerBuild: { attempted, success, image, error? },
//     kubernetesGeneration: { attempted, success, files?, error? },
//     kubernetesDeployment: { attempted, success, deployment?, service?, image?, error? } }
//
// GET /api/metrics?jobId=... ->
//   { success, jobId, pod, cpu, memoryBytes, memoryMiB }

/**
 * Submit a GitHub repository for analysis.
 *
 * @param {string} repoUrl
 * @returns {Promise<object>} The raw backend response object
 * @throws {Error} with .message from the backend or network
 */
export async function analyzeRepo(repoUrl) {
    const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Analysis failed');
    }

    return data;
}

/**
 * Fetch live Prometheus metrics for a deployed job.
 *
 * Returns null fields (cpu, memoryBytes, memoryMiB) when
 * Prometheus has no data for the pod yet.
 *
 * @param {string} jobId
 * @returns {Promise<object>} { success, jobId, pod, cpu, memoryBytes, memoryMiB }
 * @throws {Error} when Prometheus is unreachable or returns an error
 */
export async function fetchMetrics(jobId) {
    const response = await fetch('/api/metrics?jobId=' + encodeURIComponent(jobId));

    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.error || data.message || 'Metrics fetch failed');
    }

    return data;
}
