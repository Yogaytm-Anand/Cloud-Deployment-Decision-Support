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

export async function fetchMonitoringStatus(jobId) {
    const response = await fetch('/api/monitoring/status?jobId=' + encodeURIComponent(jobId));
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const preview = (await response.text()).substring(0, 80).replace(/\s+/g, ' ').trim();
        throw new Error(`Monitoring status endpoint returned non-JSON (HTTP ${response.status}): ${preview}`);
    }
    const data = await response.json();
    // A 503 here is a useful diagnostic state, not a transport failure.
    if (!data || typeof data !== 'object') throw new Error('Monitoring status returned an invalid response.');
    return data;
}

export async function runLoadTest(payload) {
    const response = await fetch('/api/load-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Load test failed.');
    }
    return data;
}

export async function fetchLoadTests(jobId) {
    const response = await fetch('/api/load-test?jobId=' + encodeURIComponent(jobId));
    if (!response.ok) {
        return { success: false, history: [] };
    }
    return response.json();
}

export async function calculateCostEstimate(payload) {
    const response = await fetch('/api/cost-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Could not calculate the estimate.');
    }
    return data;
}

async function readJsonResponse(response, fallbackMessage) {
    const body = await response.text();
    try {
        return JSON.parse(body);
    } catch {
        const isHtml = /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(body);
        const error = new Error(isHtml
            ? "The backend API returned the frontend HTML page. Restart the backend on port 4000 and try again."
            : fallbackMessage);
        error.code = isHtml ? "API_NON_JSON_RESPONSE" : "API_INVALID_RESPONSE";
        error.status = response.status;
        throw error;
    }
}

export async function fetchStoredCostEstimate(jobId) {
    const response = await fetch('/api/cost-estimate?jobId=' + encodeURIComponent(jobId));
    return readJsonResponse(response, "The saved cost estimate response was invalid.");
}

export async function generateReport(payload) {
    const response = await fetch('/api/report/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await readJsonResponse(response, "The report-generation response was invalid.");
    if (!response.ok || !data.success) {
        const error = new Error(data.message || 'Report generation failed.');
        error.code = data.code;
        error.prerequisites = data.prerequisites;
        throw error;
    }
    return data;
}

export async function fetchStoredReport(jobId) {
    const response = await fetch('/api/report?jobId=' + encodeURIComponent(jobId));
    return readJsonResponse(response, "The saved report response was invalid.");
}
