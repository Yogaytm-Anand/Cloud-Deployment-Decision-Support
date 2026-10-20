const { exec, spawn, execFile } = require("child_process");
const express = require("express");
const simpleGit = require("simple-git");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { performance } = require("perf_hooks");
// Monitoring has one canonical configuration. PROMETHEUS_URL points at the single
// Prometheus process; the Kubernetes API proxy is used only for Kubernetes service
// probes and as an explicitly configured fallback, never as a second Prometheus.
const KUBERNETES_PROXY_URL = process.env.KUBERNETES_PROXY_URL || "http://127.0.0.1:50527";
const PROMETHEUS_SERVICE_NAMESPACE = process.env.PROMETHEUS_SERVICE_NAMESPACE || "monitoring";
const PROMETHEUS_SERVICE_NAME = process.env.PROMETHEUS_SERVICE_NAME || "monitoring-kube-prometheus-prometheus";
const PROMETHEUS_SERVICE_PORT = Number(process.env.PROMETHEUS_SERVICE_PORT || 9090);
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://127.0.0.1:9090";
const PROMETHEUS_REQUIRED_TARGET_JOBS = (process.env.PROMETHEUS_REQUIRED_TARGET_JOBS || "kubernetes-cadvisor")
    .split(",")
    .map((job) => job.trim())
    .filter(Boolean);
const PROMETHEUS_KUBERNETES_SERVICE_PATH = `/api/v1/namespaces/${encodeURIComponent(PROMETHEUS_SERVICE_NAMESPACE)}/services/${encodeURIComponent(PROMETHEUS_SERVICE_NAME)}:${PROMETHEUS_SERVICE_PORT}/proxy`;
const KUBERNETES_PROXY_AUTOSTART = process.env.KUBERNETES_PROXY_AUTOSTART !== "false";
const RESPONSE_TIME_TARGET_MS = 500;
const MAX_PROBE_HISTORY = 60;
const probeHistory = new Map();
let loadTestRunning = false;
const loadTestHistory = new Map();
const MAX_LOAD_TEST_HISTORY = 12;

const app = express();

function delay(milliseconds, signal) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        const timeout = setTimeout(finish, milliseconds);
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
    });
}

async function isKubernetesProxyAvailable() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
        const response = await fetch(`${KUBERNETES_PROXY_URL}/api`, {
            signal: controller.signal
        });
        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function isLocalPortOccupied(host, port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port: Number(port) });
        const done = (occupied) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(occupied);
        };
        socket.setTimeout(1000);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
    });
}

// Prometheus reaches Minikube's cAdvisor endpoint through this local proxy.
// Keep the dashboard self-healing after the local stack is restarted.
async function ensureKubernetesProxy() {
    if (!KUBERNETES_PROXY_AUTOSTART || await isKubernetesProxyAvailable()) {
        return;
    }

    const proxyUrl = new URL(KUBERNETES_PROXY_URL);
    const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    const port = proxyUrl.port || "80";

    if (!localHosts.has(proxyUrl.hostname)) {
        console.warn("Kubernetes proxy is unavailable; not starting a proxy for a non-local URL.");
        return;
    }
    if (await isLocalPortOccupied(proxyUrl.hostname, port)) {
        console.warn(`Kubernetes proxy port ${port} is already occupied, but it is not a healthy Kubernetes API proxy at ${KUBERNETES_PROXY_URL}. Resolve the conflict or set KUBERNETES_PROXY_URL; no process was stopped.`);
        return;
    }

    const proxy = spawn(
        "kubectl",
        [
            "proxy",
            `--port=${port}`,
            "--address=127.0.0.1",
            "--accept-hosts=^127\.0\.0\.1$,^localhost$"
        ],
        { detached: true, stdio: "ignore" }
    );
    proxy.once("error", (error) => {
        console.warn("Unable to launch the Kubernetes API proxy:", error.message);
    });
    proxy.unref();

    for (let attempt = 0; attempt < 10; attempt += 1) {
        await delay(500);
        if (await isKubernetesProxyAvailable()) {
            console.log(`Kubernetes API proxy is available at ${KUBERNETES_PROXY_URL}`);
            return;
        }
    }

    console.warn("Kubernetes API proxy did not become available; service probes may be unavailable.");
}


if (process.env.ALLOWED_ORIGIN) {
    app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
            return res.sendStatus(204);
        }
        next();
    });
}

app.use(express.json());

const PORT = Number(process.env.PORT) || 4000;

function prometheusCandidates(pathname) {
    const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const candidates = [];
    if (PROMETHEUS_URL) candidates.push(`${PROMETHEUS_URL.replace(/\/+$/, "")}${cleanPath}`);
    candidates.push(`${KUBERNETES_PROXY_URL.replace(/\/+$/, "")}${PROMETHEUS_KUBERNETES_SERVICE_PATH}${cleanPath}`);
    return [...new Set(candidates)];
}

async function fetchWithTimeout(targetUrl, { signal, timeoutMs = 5000 } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        const abortFromCaller = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener("abort", abortFromCaller, { once: true });
        try {
            return await fetch(targetUrl, { signal: controller.signal });
        } catch (error) {
            if (timedOut) throw new Error(`request timed out after ${timeoutMs} ms`, { cause: error });
            throw error;
        } finally {
            signal?.removeEventListener("abort", abortFromCaller);
        }
    } finally {
        clearTimeout(timeout);
    }
}

async function requestPrometheus(pathname, { signal, timeoutMs = 5000 } = {}) {
    const failures = [];
    for (const url of prometheusCandidates(pathname)) {
        try {
            const response = await fetchWithTimeout(url, { signal, timeoutMs });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const contentType = response.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) {
                const preview = (await response.text()).substring(0, 120).replace(/\s+/g, " ").trim();
                throw new Error(
                    `Expected JSON from Prometheus but received "${contentType}". ` +
                    `Response preview: ${preview}. ` +
                    "This usually means the request was routed to a web server or proxy that returned an HTML error page instead of Prometheus."
                );
            }
            return { response, endpoint: url };
        } catch (error) {
            failures.push(`${url}: ${error.message}`);
        }
    }
    throw new Error(`Prometheus is unreachable. ${failures.join("; ")}`);
}

async function queryPrometheus(query, { signal } = {}) {
    const encodedQuery = encodeURIComponent(query);
    const { response } = await requestPrometheus(`/api/v1/query?query=${encodedQuery}`, { signal, timeoutMs: 15000 });
    const data = await response.json();
    if (data.status !== "success") {
        throw new Error(data.error || "Prometheus query failed");
    }
    return data.data;
}

async function queryPrometheusWithRetry(query, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await queryPrometheus(query);
        } catch (error) {
            lastError = error;
            if (attempt < attempts - 1) await delay(250 * (attempt + 1));
        }
    }
    throw lastError;
}

function parseDurationSeconds(duration) {
    const match = /^(\d+)(s|m)$/.exec(duration);
    return match ? Number(match[1]) * (match[2] === "m" ? 60 : 1) : NaN;
}

function validateLoadTestConfig(body) {
    const presets = {
        light: { vus: 10, duration: "20s" },
        medium: { vus: 50, duration: "30s" },
        heavy: { vus: 100, duration: "30s" }
    };
    const level = body.loadLevel || "light";
    if (!Object.hasOwn(presets, level) && level !== "custom") {
        throw new Error("Invalid loadLevel. Use light, medium, heavy, or custom.");
    }
    const preset = presets[level];
    const finalVus = level === "custom" ? (body.vus ?? 10) : (body.vus ?? preset.vus);
    const finalDuration = level === "custom" ? (body.duration ?? "30s") : (body.duration ?? preset.duration);
    if (!Number.isInteger(finalVus) || finalVus < 1 || finalVus > 100) {
        throw new Error("vus must be an integer between 1 and 100.");
    }
    if (typeof finalDuration !== "string" || !Number.isFinite(parseDurationSeconds(finalDuration)) ||
        parseDurationSeconds(finalDuration) < 1 || parseDurationSeconds(finalDuration) > 300) {
        throw new Error("duration must be between 1s and 5m, using seconds or minutes (for example, 20s).");
    }
    return { level, vus: finalVus, duration: finalDuration };
}

function extractK6Metrics(summary) {
    const metrics = summary?.metrics;
    const required = ["http_reqs", "http_req_duration", "http_req_failed"];
    const getMetricValues = (metric) => metric?.values ?? metric?.data?.values ?? metric?.data ?? metric;
    const metricValues = Object.fromEntries(
        required.map((name) => [name, getMetricValues(metrics?.[name])])
    );
    const missingMetrics = required.filter((name) => !metricValues[name] || typeof metricValues[name] !== "object");
    if (missingMetrics.length) {
        const availableMetrics = Object.keys(metrics || {});
        const metricShapes = Object.fromEntries(required.map((name) => {
            const metric = metrics?.[name];
            return [name, {
                type: typeof metric,
                keys: metric && typeof metric === "object" ? Object.keys(metric) : [],
                valuesKeys: metric?.values && typeof metric.values === "object" ? Object.keys(metric.values) : [],
                dataKeys: metric?.data && typeof metric.data === "object" ? Object.keys(metric.data) : []
            }];
        }));
        const diagnostic = {
            summaryKeys: Object.keys(summary || {}),
            missingMetrics,
            availableMetrics,
            metricShapes
        };
        console.error("k6 summary metric diagnostic:", JSON.stringify(diagnostic));
        throw new Error(
            `k6 summary is missing required HTTP metrics: ${missingMetrics.join(", ")}. ` +
            `Available metrics: ${availableMetrics.join(", ") || "none"}. ` +
            `Shapes: ${JSON.stringify(metricShapes)}.`
        );
    }
    const requests = metricValues.http_reqs.count;
    const perSecond = metricValues.http_reqs.rate;
    const duration = metricValues.http_req_duration;
    const failedValues = metricValues.http_req_failed;
    const failedRate = failedValues.rate ?? failedValues.value ?? (
        Number.isFinite(failedValues.passes) && Number.isFinite(failedValues.fails) &&
        failedValues.passes + failedValues.fails > 0
            ? failedValues.fails / (failedValues.passes + failedValues.fails)
            : undefined
    );
    const normalizedMetrics = {
        totalRequests: requests,
        requestsPerSecond: perSecond,
        averageResponseTimeMs: duration.avg,
        p95ResponseTimeMs: duration["p(95)"],
        maxResponseTimeMs: duration.max,
        failedRequestRate: failedRate
    };
    const invalidFields = Object.entries(normalizedMetrics)
        .filter(([, value]) => !Number.isFinite(value))
        .map(([name]) => name);
    if (invalidFields.length) {
        const details = {
            invalidFields,
            normalizedMetricKeys: Object.fromEntries(
                required.map((name) => [name, Object.keys(metricValues[name])])
            )
        };
        console.error("k6 summary value diagnostic:", JSON.stringify(details));
        throw new Error(`k6 summary contains missing or invalid metric values: ${JSON.stringify(details)}.`);
    }
    return {
        totalRequests: requests,
        requestsPerSecond: Number(perSecond.toFixed(2)),
        averageResponseTimeMs: Number(duration.avg.toFixed(2)),
        p95ResponseTimeMs: Number(duration["p(95)"].toFixed(2)),
        maxResponseTimeMs: Number(duration.max.toFixed(2)),
        failedRequestPercentage: Number((failedRate * 100).toFixed(2))
    };
}

// Resolve the k6 executable path robustly.
// Priority: K6_PATH env → candidates in PATH (via where.exe/which) → Windows well-known install locations.
// Returns the resolved executable path, or throws a clear actionable error.
async function resolveK6Executable() {
    // 1. Explicit override via environment variable (highest priority).
    const envPath = process.env.K6_PATH;
    if (envPath) {
        try {
            await fs.promises.access(envPath, fs.constants.F_OK);
            return envPath;
        } catch {
            throw new Error(
                `K6_PATH is set to "${envPath}" but the file is not accessible. ` +
                "Check the path and file permissions."
            );
        }
    }

    // 2. Try to resolve via PATH using 'where.exe' on Windows or 'which' on Unix.
    const isWindows = process.platform === "win32";
    const locator = isWindows ? "where.exe" : "which";
    const candidate = await new Promise((resolve) => {
        execFile(locator, ["k6"], { windowsHide: true }, (err, stdout) => {
            if (err || !stdout.trim()) {
                resolve(null);
            } else {
                // where.exe can return multiple lines; use the first.
                resolve(stdout.trim().split(/\r?\n/)[0].trim());
            }
        });
    });
    if (candidate) return candidate;

    // 3. On Windows, also probe the standard installation directory.
    if (isWindows) {
        const wellKnown = [
            "C:\\Program Files\\k6\\k6.exe",
            path.join(process.env.ProgramFiles || "C:\\Program Files", "k6", "k6.exe"),
            path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "k6", "k6.exe"),
            path.join(process.env.LOCALAPPDATA || "", "k6", "k6.exe")
        ].filter(Boolean);
        for (const wk of wellKnown) {
            try {
                await fs.promises.access(wk, fs.constants.F_OK);
                return wk;
            } catch {
                // not found here — keep trying
            }
        }
    }

    throw new Error(
        "k6 executable was not found. " +
        (isWindows
            ? "Install k6 from https://k6.io/docs/get-started/installation/ and ensure " +
              "\"C:\\\\Program Files\\\\k6\" is in the system PATH, or set the K6_PATH environment variable " +
              "to the full path of k6.exe (e.g. K6_PATH=C:\\\\Program Files\\\\k6\\\\k6.exe)."
            : "Install k6 and ensure it is in PATH, or set the K6_PATH environment variable.")
    );
}

async function runK6Test(targetUrl, vus, duration, lifecycle = {}) {
    const k6Executable = await resolveK6Executable().catch((err) => {
        throw new Error(`k6 test failed: ${err.message}`);
    });
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cdds-k6-"));
    const scriptPath = path.join(tempDir, "test.js");
    const summaryPath = path.join(tempDir, "summary.json");
    const script = `import http from 'k6/http';\nhttp.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }));\nexport const options = { vus: ${vus}, duration: ${JSON.stringify(duration)} };\nexport default function () { http.get(${JSON.stringify(targetUrl)}); }\n`;
    try {
        await fs.promises.writeFile(scriptPath, script, "utf8");
        const timeout = (parseDurationSeconds(duration) + 60) * 1000;
        let startedAt = null;
        let finishedAt = null;
        await new Promise((resolve, reject) => {
            const child = execFile(k6Executable, ["run", `--summary-export=${summaryPath}`, scriptPath], {
                timeout,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true
            }, (error, stdout, stderr) => {
                finishedAt = Date.now();
                lifecycle.onFinish?.(finishedAt);
                if (error) reject({ error, stdout, stderr });
                else resolve({ stdout, stderr });
            });
            child.once("spawn", () => {
                startedAt = Date.now();
                lifecycle.onStart?.(startedAt);
            });
        });
        const summary = JSON.parse(await fs.promises.readFile(summaryPath, "utf8"));
        return { summary, startedAt, finishedAt };
    } catch (error) {
        const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.error?.message || error.message;
        throw new Error(`k6 test failed: ${detail}`);
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

async function collectResourceMetric(jobId, metric, startedAt, durationSeconds, signal) {
    const podPattern = `${jobId}-.*`;
    const isCpu = metric === "cpu";
    const query = isCpu
        ? `sum(rate(container_cpu_usage_seconds_total{namespace="default",pod=~"${podPattern}",container!="POD",container!=""}[2m]))`
        : `sum(container_memory_working_set_bytes{namespace="default",pod=~"${podPattern}",container!="POD",container!=""})`;
    const samples = [];
    const errors = [];
    const endAt = startedAt + durationSeconds * 1000;
    while (!signal.aborted && Date.now() < endAt) {
        try {
            const data = await queryPrometheus(query, { signal });
            const value = Number(data.result?.[0]?.value?.[1]);
            if (Number.isFinite(value) && !signal.aborted && Date.now() <= endAt) {
                samples.push({ value, sampledAt: new Date().toISOString() });
            } else if (!Number.isFinite(value) && !signal.aborted) {
                errors.push(`Prometheus returned no ${isCpu ? "CPU" : "memory"} series for this deployment.`);
            }
        } catch (error) {
            if (!signal.aborted) errors.push(error.message);
        }
        if (!signal.aborted && Date.now() < endAt) {
            await delay(Math.min(2000, Math.max(250, endAt - Date.now())), signal);
        }
    }
    return { samples, errors };
}

async function verifyServiceAndGetTarget(jobId, targetPath = "/") {
    const service = `${jobId}-service`;
    const serviceUrl = `${KUBERNETES_PROXY_URL}/api/v1/namespaces/default/services/${encodeURIComponent(service)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(serviceUrl, { signal: controller.signal });
        if (response.status === 404) throw Object.assign(new Error(`Deployment service ${service} was not found.`), { status: 404 });
        if (!response.ok) throw new Error(`Kubernetes API proxy returned ${response.status} while checking the service.`);
        const info = await response.json();
        const port = info.spec?.ports?.find((item) => item.port === 3000) || info.spec?.ports?.[0];
        if (!port) throw new Error(`Service ${service} has no usable port.`);
        const safePath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
        return `${KUBERNETES_PROXY_URL}/api/v1/namespaces/default/services/${encodeURIComponent(service)}:${port.port}/proxy${safePath}`;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(`Timed out checking Kubernetes Service ${service} through the API proxy.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function sampleResourcesDuringTest(jobId, startedAt, durationSeconds, signal) {
    const [cpuResult, memoryResult] = await Promise.all([
        collectResourceMetric(jobId, "cpu", startedAt, durationSeconds, signal),
        collectResourceMetric(jobId, "memory", startedAt, durationSeconds, signal)
    ]);
    const cpuSamples = cpuResult.samples;
    const memorySamples = memoryResult.samples;
    const samples = Math.max(cpuSamples.length, memorySamples.length);
    const samplingErrors = [...new Set([...cpuResult.errors, ...memoryResult.errors])];
    if (!samples) {
        return {
            available: false,
            sampling: "during_test",
            samples: 0,
            cpuSamples: 0,
            memorySamples: 0,
            error: samplingErrors.join("; ") || "No Prometheus resource samples were available during the k6 run."
        };
    }
    const cpuValues = cpuSamples.map((sample) => sample.value);
    const memoryValues = memorySamples.map((sample) => sample.value);
    const mean = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;
    const sampleTimes = [...cpuSamples, ...memorySamples].map((sample) => sample.sampledAt).sort();
    return {
        available: true,
        sampling: "during_test",
        samples,
        cpuSamples: cpuSamples.length,
        memorySamples: memorySamples.length,
        sampleRange: {
            first: sampleTimes[0],
            last: sampleTimes[sampleTimes.length - 1]
        },
        cpuRateWindowSeconds: 120,
        cpuCoresAverage: mean(cpuValues),
        cpuCoresPeak: cpuValues.length ? Number(Math.max(...cpuValues).toFixed(4)) : null,
        memoryBytesAverage: mean(memoryValues),
        memoryBytesPeak: memoryValues.length ? Math.max(...memoryValues) : null,
        ...(samplingErrors.length ? { warning: samplingErrors.join("; ") } : {})
    };
}


async function probeDeployedService(jobId) {
    const serviceName = encodeURIComponent(`${jobId}-service`);
    const url = `${KUBERNETES_PROXY_URL}/api/v1/namespaces/default/services/${serviceName}:3000/proxy/`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const startedAt = performance.now();
    let succeeded = false;

    try {
        const response = await fetch(url, { signal: controller.signal });
        succeeded = response.ok;
    } catch (error) {
        succeeded = false;
    } finally {
        clearTimeout(timeout);
    }

    const responseTimeMs = Math.round(performance.now() - startedAt);
    const samples = probeHistory.get(jobId) || [];
    samples.push(succeeded);
    if (samples.length > MAX_PROBE_HISTORY) samples.shift();
    probeHistory.set(jobId, samples);

    const failures = samples.filter((sample) => !sample).length;
    const errorRate = Number(((failures / samples.length) * 100).toFixed(2));

    return {
        responseTimeMs,
        responseTimePercentage: Math.min(100, (responseTimeMs / RESPONSE_TIME_TARGET_MS) * 100),
        errorRate,
        errorRatePercentage: errorRate
    };
}

function deploymentMetricQueries(jobId) {
    const podPattern = `${jobId}-.*`;
    const selector = `namespace="default",pod=~"${podPattern}",container!="POD",container!=""`;
    return {
        cpu: `sum(rate(container_cpu_usage_seconds_total{${selector}}[2m]))`,
        memory: `sum(container_memory_working_set_bytes{${selector}})`,
        cpuLimit: `sum(container_spec_cpu_quota{${selector}}) / sum(container_spec_cpu_period{${selector}})`,
        memoryLimit: `sum(container_spec_memory_limit_bytes{${selector}})`
    };
}

function firstFiniteVectorValue(data) {
    const value = Number(data?.result?.[0]?.value?.[1]);
    return Number.isFinite(value) ? value : null;
}

async function getMonitoringStatus(jobId) {
    const status = {
        prometheus: { state: "unavailable", endpoint: null, message: null },
        targets: { state: "unknown", requiredJobs: PROMETHEUS_REQUIRED_TARGET_JOBS, up: [], down: [] },
        queries: { state: jobId ? "pending" : "not_requested", cpu: null, memory: null },
        ready: false
    };
    try {
        const { response, endpoint } = await requestPrometheus("/api/v1/status/buildinfo", { timeoutMs: 5000 });
        const buildInfo = await response.json();
        if (buildInfo.status !== "success") throw new Error(buildInfo.error || "Prometheus readiness request failed");
        status.prometheus = { state: "ready", endpoint: endpoint.replace(/\/api\/v1\/status\/buildinfo.*$/, ""), version: buildInfo.data?.version || null };
    } catch (error) {
        status.prometheus.message = error.message;
        return status;
    }

    try {
        const { response } = await requestPrometheus("/api/v1/targets", { timeoutMs: 8000 });
        const targetsPayload = await response.json();
        if (targetsPayload.status !== "success") throw new Error(targetsPayload.error || "Prometheus target request failed");
        const activeTargets = targetsPayload.data?.activeTargets || [];
        const targetByJob = (job) => activeTargets.filter((target) => target.labels?.job === job || target.discoveredLabels?.job === job);
        for (const job of PROMETHEUS_REQUIRED_TARGET_JOBS) {
            const targets = targetByJob(job);
            if (targets.some((target) => target.health === "up")) status.targets.up.push(job);
            else status.targets.down.push(job);
        }
        status.targets.state = status.targets.down.length ? "degraded" : "ready";
    } catch (error) {
        status.targets = { ...status.targets, state: "unavailable", message: error.message };
    }

    if (jobId) {
        try {
            const queries = deploymentMetricQueries(jobId);
            const [cpuData, memoryData] = await Promise.all([
                queryPrometheusWithRetry(queries.cpu),
                queryPrometheusWithRetry(queries.memory)
            ]);
            status.queries.cpu = firstFiniteVectorValue(cpuData);
            status.queries.memory = firstFiniteVectorValue(memoryData);
            status.queries.state = status.queries.cpu !== null && status.queries.memory !== null ? "ready" : "no_data";
        } catch (error) {
            status.queries.state = "failed";
            status.queries.message = error.message;
        }
    }
    status.ready = status.prometheus.state === "ready" && status.targets.state === "ready" &&
        (!jobId || status.queries.state === "ready");
    return status;
}

async function getKubernetesDeploymentResources(jobId) {
    const deploymentUrl = `${KUBERNETES_PROXY_URL}/apis/apps/v1/namespaces/default/deployments/${encodeURIComponent(jobId)}`;
    const response = await fetchWithTimeout(deploymentUrl, { timeoutMs: 8000 });
    if (response.status === 404) throw new Error(`Kubernetes deployment ${jobId} was not found.`);
    if (!response.ok) throw new Error(`Kubernetes API proxy returned ${response.status} while reading deployment resources.`);
    const deployment = await response.json();
    const container = deployment.spec?.template?.spec?.containers?.[0];
    if (!container) throw new Error(`Deployment ${jobId} has no container specification.`);
    return {
        replicas: deployment.spec?.replicas ?? 1,
        requests: container.resources?.requests || {},
        limits: container.resources?.limits || {}
    };
}

function parseCpuMillicores(value) {
    if (typeof value !== "string") return null;
    if (/^\d+m$/.test(value)) return Number.parseInt(value, 10);
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
    return null;
}

function parseMemoryMiB(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/.exec(value);
    if (!match) return null;
    const multipliers = { Ki: 1 / 1024, Mi: 1, Gi: 1024, K: 1000 / (1024 * 1024), M: 1000 * 1000 / (1024 * 1024), G: 1000 * 1000 * 1000 / (1024 * 1024) };
    return Number(match[1]) * (multipliers[match[2]] ?? 1 / (1024 * 1024));
}

function runCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd }, (error, stdout, stderr) => {

            if (error) {
                reject({
                    error: error.message,
                    stdout,
                    stderr
                });

                return;
            }

            resolve({
                stdout,
                stderr
            });
        });
    });
}


function generateKubernetesFiles(repoPath, imageName, jobId) {

    const kubernetesPath = path.join(
        repoPath,
        "kubernetes"
    );

    if (!fs.existsSync(kubernetesPath)) {
        fs.mkdirSync(kubernetesPath);
    }


    
    const deploymentYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${jobId}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cdds-app
      cdds-job: ${jobId}
  template:
    metadata:
      labels:
        app: cdds-app
        cdds-job: ${jobId}
    spec:
      containers:
        - name: cdds-app
          image: ${imageName}
          imagePullPolicy: Never
          ports:
            - containerPort: 3000
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"
`;


    // Kubernetes Service
    const serviceYaml = `
apiVersion: v1
kind: Service
metadata:
  name: ${jobId}-service
spec:
  selector:
    app: cdds-app
    cdds-job: ${jobId}
  ports:
    - protocol: TCP
      port: 3000
      targetPort: 3000
  type: NodePort
`;


    fs.writeFileSync(
        path.join(
            kubernetesPath,
            "deployment.yaml"
        ),
        deploymentYaml.trim()
    );


    fs.writeFileSync(
        path.join(
            kubernetesPath,
            "service.yaml"
        ),
        serviceYaml.trim()
    );


    return {
        deployment: "deployment.yaml",
        service: "service.yaml"
    };
}



async function deployToKubernetes(imageName, repoPath, jobId) {

    console.log(
        `Deploying ${imageName} to Kubernetes...`
    );


    const deploymentPath = path.join(
        repoPath,
        "kubernetes",
        "deployment.yaml"
    );


    const servicePath = path.join(
        repoPath,
        "kubernetes",
        "service.yaml"
    );


    if (!fs.existsSync(deploymentPath)) {
        throw new Error(
            "Kubernetes deployment.yaml not found"
        );
    }


    if (!fs.existsSync(servicePath)) {
        throw new Error(
            "Kubernetes service.yaml not found"
        );
    }


    
    await runCommand(
        `minikube image load ${imageName}`
    );


    
    await runCommand(
        `kubectl apply -f "${deploymentPath}"`
    );


    
    await runCommand(
        `kubectl apply -f "${servicePath}"`
    );


    await runCommand(
    `kubectl rollout status deployment/${jobId} --timeout=120s`
);


    console.log(
        "Kubernetes deployment successful"
    );


    return {
    success: true,
    deployment: jobId,
    service: `${jobId}-service`,
    image: imageName
    };
}


// --------------------------------------------------
// MAIN CDDS ANALYZE API
// --------------------------------------------------

app.post("/api/analyze", async (req, res) => {

    const { repoUrl } = req.body;


    // Check URL
    if (!repoUrl) {

        return res.status(400).json({
            success: false,
            message: "GitHub repository URL is required"
        });

    }


    // Basic GitHub validation
    if (!repoUrl.startsWith("https://github.com/")) {

        return res.status(400).json({
            success: false,
            message: "Only GitHub repositories are supported"
        });

    }


    // Unique job ID
    const jobId = `cdds-${Date.now()}`;

    const repoPath = path.join(
        os.tmpdir(),
        jobId
    );


    try {

        // --------------------------------------------------
        // 1. Clone repository
        // --------------------------------------------------

        console.log(
            `Cloning repository: ${repoUrl}`
        );

        await simpleGit().clone(
            repoUrl,
            repoPath
        );

        console.log(
            "Repository cloned successfully"
        );


        // --------------------------------------------------
        // 2. Validate Dockerfile
        // --------------------------------------------------

        const dockerfilePath = path.join(
            repoPath,
            "Dockerfile"
        );

        const hasDockerfile =
            fs.existsSync(dockerfilePath);


        // --------------------------------------------------
        // 3. Build Docker image
        // --------------------------------------------------

        let dockerBuild = {
            attempted: false,
            success: false,
            image: null
        };


        if (hasDockerfile) {

            const imageName =
                `cdds-app:${jobId}`;


            dockerBuild.attempted = true;
            dockerBuild.image = imageName;


            try {

                console.log(
                    `Building Docker image: ${imageName}`
                );


                await runCommand(
                    `docker build -t ${imageName} .`,
                    repoPath
                );


                dockerBuild.success = true;


                console.log(
                    `Docker image built successfully: ${imageName}`
                );


            } catch (error) {

                console.error(
                    "Docker build failed:",
                    error
                );


                dockerBuild.success = false;

                dockerBuild.error =
                    error.stderr ||
                    error.error;

            }

        }


        // --------------------------------------------------
        // 4. Generate Kubernetes files
        // --------------------------------------------------

        let kubernetesGeneration = {
            attempted: false,
            success: false,
            files: []
        };


        if (dockerBuild.success) {

            try {

                const generatedFiles =
                    generateKubernetesFiles(
                        repoPath,
                        dockerBuild.image,
                        jobId
                    );


                kubernetesGeneration = {
                    attempted: true,
                    success: true,
                    files: [
                        generatedFiles.deployment,
                        generatedFiles.service
                    ]
                };


                console.log(
                    "Kubernetes files generated successfully"
                );


            } catch (error) {

                kubernetesGeneration = {
                    attempted: true,
                    success: false,
                    error: error.message
                };

            }

        }


        // --------------------------------------------------
        // 5. Deploy to Kubernetes
        // --------------------------------------------------

        let kubernetesDeployment = {
            attempted: false,
            success: false
        };


        if (
            dockerBuild.success &&
            kubernetesGeneration.success
        ) {

            kubernetesDeployment.attempted = true;


            try {

                kubernetesDeployment =
                    await deployToKubernetes(
                        dockerBuild.image,
                        repoPath,
                        jobId
                    );


                kubernetesDeployment.attempted =
                    true;


            } catch (error) {

                console.error(
                    "Kubernetes deployment failed:",
                    error
                );


                kubernetesDeployment = {
                    attempted: true,
                    success: false,
                    error:
                        error.stderr ||
                        error.error ||
                        error.message
                };

            }

        }


        // --------------------------------------------------
        // 6. Final response
        // --------------------------------------------------

        res.json({

            success: true,

            jobId: jobId,

            repository: repoUrl,

            validation: {
                dockerfile: hasDockerfile
            },

            dockerBuild: dockerBuild,

            kubernetesGeneration:
                kubernetesGeneration,

            kubernetesDeployment:
                kubernetesDeployment

        });


    } catch (error) {

        console.error(error);


        res.status(500).json({

            success: false,

            message:
                "Repository analysis failed",

            error: error.message

        });

    }

});


// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", (req, res) => {

    res.json({
        status: "Backend running"
    });

});

// --------------------------------------------------
// Metrics Api
// --------------------------------------------------

app.get("/api/metrics", async (req, res) => {

    const { jobId } = req.query;

    if (typeof jobId !== "string" || !/^cdds-[a-zA-Z0-9-]{1,80}$/.test(jobId)) {
        return res.status(400).json({
            success: false,
            message: "A valid jobId is required."
        });
    }

    try {

        const podPattern = `${jobId}-.*`;

        const cpuQuery = `
            rate(
                container_cpu_usage_seconds_total{
                    namespace="default",
                    pod=~"${podPattern}",
                    container!="POD",
                    container!=""
                }[2m]
            )
        `;

        const memoryQuery = `
            container_memory_working_set_bytes{
                namespace="default",
                pod=~"${podPattern}",
                container!="POD",
                container!=""
            }
        `;

        const cpuLimitQuery = `
            container_spec_cpu_quota{
                namespace="default",
                pod=~"${podPattern}",
                container!="POD",
                container!=""
            }
            /
            container_spec_cpu_period{
                namespace="default",
                pod=~"${podPattern}",
                container!="POD",
                container!=""
            }
        `;

        const memoryLimitQuery = `
            container_spec_memory_limit_bytes{
                namespace="default",
                pod=~"${podPattern}",
                container!="POD",
                container!=""
            }
        `;

        const [cpuData, memoryData, cpuLimitData, memoryLimitData, serviceProbe] = await Promise.all([
            queryPrometheusWithRetry(cpuQuery),
            queryPrometheusWithRetry(memoryQuery),
            queryPrometheusWithRetry(cpuLimitQuery),
            queryPrometheusWithRetry(memoryLimitQuery),
            probeDeployedService(jobId)
        ]);

        const cpuResult = cpuData.result[0];
        const memoryResult = memoryData.result[0];
        const cpuLimitResult = cpuLimitData.result[0];
        const memoryLimitResult = memoryLimitData.result[0];

        const cpu = firstFiniteVectorValue(cpuData);

        const memoryBytes = firstFiniteVectorValue(memoryData);

        const cpuLimitCores = firstFiniteVectorValue(cpuLimitData);

        const memoryLimitBytes = firstFiniteVectorValue(memoryLimitData);

        const toPercentage = (usage, limit) => (
            Number.isFinite(usage) && Number.isFinite(limit) && limit > 0
                ? Math.min(100, Math.max(0, (usage / limit) * 100))
                : null
        );

        res.json({
            success: true,
            jobId: jobId,
            pod: cpuResult?.metric?.pod ||
                 memoryResult?.metric?.pod ||
                 null,
            cpu,
            cpuPercentage: toPercentage(cpu, cpuLimitCores),
            memoryBytes,
            memoryPercentage: toPercentage(memoryBytes, memoryLimitBytes),
            memoryMiB: memoryBytes === null
                ? null
                : Number((memoryBytes / 1024 / 1024).toFixed(2)),
            ...serviceProbe
        });

    } catch (error) {

        console.error(
            "Prometheus error:",
            error.message
        );

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get("/api/monitoring/status", async (req, res) => {
    const { jobId } = req.query;
    if (jobId !== undefined && (typeof jobId !== "string" || !/^cdds-[a-zA-Z0-9-]{1,80}$/.test(jobId))) {
        return res.status(400).json({ success: false, message: "jobId must be a valid deployment ID." });
    }
    const status = await getMonitoringStatus(jobId);
    return res.status(status.ready ? 200 : 503).json({ success: status.ready, ...status });
});

app.post("/api/load-test", async (req, res) => {
    const { jobId, targetPath = "/" } = req.body || {};
    if (typeof jobId !== "string" || !/^cdds-[a-zA-Z0-9-]{1,80}$/.test(jobId)) {
        return res.status(400).json({ success: false, message: "A valid jobId is required." });
    }
    const targetPathOnly = typeof targetPath === "string" ? targetPath.split("?", 1)[0] : "";
    if (typeof targetPath !== "string" || !targetPath.startsWith("/") || targetPath.startsWith("//") ||
        /[\\\r\n]/.test(targetPath) || /%2e|%2f/i.test(targetPathOnly) ||
        /(?:^|\/)\.\.(?:\/|$)/.test(targetPathOnly) || targetPath.length > 200) {
        return res.status(400).json({ success: false, message: "targetPath must be a local URL path beginning with a single slash." });
    }
    let config;
    try {
        config = validateLoadTestConfig(req.body || {});
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    if (loadTestRunning) {
        return res.status(429).json({ success: false, message: "Another load test is already running." });
    }
    loadTestRunning = true;
    try {
        const targetUrl = await verifyServiceAndGetTarget(jobId, targetPath);
        const resourceSampling = new AbortController();
        let resourcesPromise;
        const k6Result = await runK6Test(targetUrl, config.vus, config.duration, {
            onStart: (startedAt) => {
                resourcesPromise = sampleResourcesDuringTest(
                    jobId,
                    startedAt,
                    parseDurationSeconds(config.duration),
                    resourceSampling.signal
                );
            },
            onFinish: () => resourceSampling.abort()
        });
        const resources = resourcesPromise
            ? await resourcesPromise
            : {
                available: false,
                sampling: "during_test",
                samples: 0,
                error: "Resource sampling did not start because k6 did not start."
            };
        const loadMetrics = extractK6Metrics(k6Result.summary);
        const result = {
            success: true,
            jobId,
            targetUrl,
            loadTest: {
                level: config.level,
                vus: config.vus,
                duration: config.duration,
                executionDurationMs: Math.max(0, k6Result.finishedAt - k6Result.startedAt),
                ...loadMetrics
            },
            resources
        };
        const history = loadTestHistory.get(jobId) || [];
        history.push({ ...result, completedAt: new Date().toISOString() });
        loadTestHistory.set(jobId, history.slice(-MAX_LOAD_TEST_HISTORY));
        return res.json(result);
    } catch (error) {
        console.error("Load test failed:", error.message);
        const status = error.status || (error.message.startsWith("k6 test failed:") ? 502 : 503);
        return res.status(status).json({ success: false, jobId, message: error.message });
    } finally {
        loadTestRunning = false;
    }
});

app.get("/api/load-test", (req, res) => {
    const { jobId } = req.query;
    if (typeof jobId !== "string" || !/^cdds-[a-zA-Z0-9-]{1,80}$/.test(jobId)) {
        return res.status(400).json({ success: false, message: "A valid jobId is required." });
    }
    const history = loadTestHistory.get(jobId) || [];
    return res.json({ success: true, jobId, history });
});

// --------------------------------------------------
// AWS COST ESTIMATION (reference model; no AWS resources are created)
// Default rates are public On-Demand reference rates for us-east-1.
// Re-check the AWS pricing pages before using these values commercially.
// --------------------------------------------------
const AWS_COST_REFERENCE = {
    region: "us-east-1",
    hoursPerMonth: 730,
    eksStandardHourly: 0.10,
    eksExtendedHourly: 0.60,
    // Linux On-Demand reference rates for us-east-1.
    // Source: AWS EC2 T3 instance pricing page.
    instances: {
        "t3.micro":  { vcpu: 2, memoryGiB: 1, hourly: 0.0104 },
        "t3.small":  { vcpu: 2, memoryGiB: 2, hourly: 0.0208 },
        "t3.medium": { vcpu: 2, memoryGiB: 4, hourly: 0.0416 },
        "t3.large":  { vcpu: 2, memoryGiB: 8, hourly: 0.0832 },
        "t3.xlarge": { vcpu: 4, memoryGiB: 16, hourly: 0.1664 }
    },
    // Approximate gp3 EBS storage rate for us-east-1; excludes provisioned IOPS/throughput.
    ebsGp3PerGiBMonth: 0.08,
    allocatableFraction: 0.8
};

app.post("/api/cost-estimate", async (req, res) => {
    const body = req.body || {};
    const jobId = body.jobId;
    let replicas = Number(body.replicas ?? 1);
    let cpuRequestMillicores = Number(body.cpuRequestMillicores ?? 100);
    let memoryRequestMiB = Number(body.memoryRequestMiB ?? 128);
    const requestedInstanceType = body.instanceType || "auto";
    const supportTier = body.supportTier || "standard";
    const storageGiBPerNode = Number(body.storageGiBPerNode ?? 20);
    const inputWarnings = [];
    let kubernetesResources = null;
    let monitoring = null;

    const frontendLoadTests = Array.isArray(body.loadTests) ? body.loadTests : [];
    const storedLoadTests = typeof jobId === "string" ? (loadTestHistory.get(jobId) || []) : [];
    const combinedMap = new Map();
    for (const test of [...storedLoadTests, ...frontendLoadTests]) {
        const key = test.completedAt || `${test.vus || test.loadTest?.vus}-${test.duration || test.loadTest?.duration}-${test.totalRequests || test.loadTest?.totalRequests}`;
        combinedMap.set(key, test);
    }
    const loadTests = Array.from(combinedMap.values());

    if (jobId !== undefined && (typeof jobId !== "string" || !/^cdds-[a-zA-Z0-9-]{1,80}$/.test(jobId))) {
        return res.status(400).json({ success: false, message: "jobId must be a valid deployment ID." });
    }
    if (jobId) {
        try {
            kubernetesResources = await getKubernetesDeploymentResources(jobId);
            const observedCpuRequest = parseCpuMillicores(kubernetesResources.requests.cpu);
            const observedMemoryRequest = parseMemoryMiB(kubernetesResources.requests.memory);

            // Allow explicit overrides from body; fall back to Kubernetes deployment resources
            if (body.replicas !== undefined) {
                replicas = Number(body.replicas);
            } else if (kubernetesResources.replicas) {
                replicas = kubernetesResources.replicas;
            }

            if (body.cpuRequestMillicores !== undefined) {
                cpuRequestMillicores = Number(body.cpuRequestMillicores);
            } else if (observedCpuRequest !== null) {
                cpuRequestMillicores = observedCpuRequest;
            } else {
                inputWarnings.push("The deployment has no parseable CPU request; the supplied fallback was used.");
            }

            if (body.memoryRequestMiB !== undefined) {
                memoryRequestMiB = Number(body.memoryRequestMiB);
            } else if (observedMemoryRequest !== null) {
                memoryRequestMiB = observedMemoryRequest;
            } else {
                inputWarnings.push("The deployment has no parseable memory request; the supplied fallback was used.");
            }
        } catch (error) {
            inputWarnings.push(`Kubernetes configuration could not be read: ${error.message}`);
        }
        monitoring = await getMonitoringStatus(jobId);
        if (!monitoring.ready) inputWarnings.push("Live CPU/memory measurements are unavailable, so node sizing falls back to Kubernetes requests.");
        if (!loadTests.length) inputWarnings.push("No completed load test is available; throughput and latency do not yet inform this estimate.");
    } else {
        inputWarnings.push("No deployment was selected; this estimate uses manually supplied Kubernetes configuration.");
    }

    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 1000) {
        return res.status(400).json({ success: false, message: "replicas must be an integer from 1 to 1000." });
    }
    if (!Number.isFinite(cpuRequestMillicores) || cpuRequestMillicores < 1 || cpuRequestMillicores > 64000) {
        return res.status(400).json({ success: false, message: "cpuRequestMillicores must be between 1 and 64000." });
    }
    if (!Number.isFinite(memoryRequestMiB) || memoryRequestMiB < 1 || memoryRequestMiB > 1048576) {
        return res.status(400).json({ success: false, message: "memoryRequestMiB must be between 1 and 1048576." });
    }
    if (!Number.isFinite(storageGiBPerNode) || storageGiBPerNode < 0 || storageGiBPerNode > 16384) {
        return res.status(400).json({ success: false, message: "storageGiBPerNode must be between 0 and 16384." });
    }
    if (!["standard", "extended"].includes(supportTier)) {
        return res.status(400).json({ success: false, message: "supportTier must be standard or extended." });
    }

    const loadCpuPeaks = loadTests.map((entry) => {
        const peak = entry.resources?.cpuCoresPeak ?? entry.cpuCoresPeak;
        return Number.isFinite(Number(peak)) ? Number(peak) * 1000 : null;
    }).filter(Number.isFinite);
    const loadMemoryPeaks = loadTests.map((entry) => {
        const peak = entry.resources?.memoryBytesPeak ?? entry.memoryBytesPeak;
        return Number.isFinite(Number(peak)) ? Number(peak) / 1024 / 1024 : null;
    }).filter(Number.isFinite);
    const loadCpuPeak = Math.max(...loadCpuPeaks, 0);
    const loadMemoryPeak = Math.max(...loadMemoryPeaks, 0);
    const liveCpuMillicores = monitoring?.queries?.state === "ready" ? monitoring.queries.cpu * 1000 : 0;
    const liveMemoryMiB = monitoring?.queries?.state === "ready" ? monitoring.queries.memory / 1024 / 1024 : 0;
    const hasLiveMeasurements = monitoring?.queries?.state === "ready";
    const measuredCpuMillicores = hasLiveMeasurements || loadCpuPeaks.length ? Math.max(liveCpuMillicores, loadCpuPeak) : null;
    const measuredMemoryMiB = hasLiveMeasurements || loadMemoryPeaks.length ? Math.max(liveMemoryMiB, loadMemoryPeak) : null;
    // A 30% headroom applies only to observed runtime use. Requests remain distinct
    // and are never rewritten from live measurements.
    const capacityCpuMillicores = Math.max(cpuRequestMillicores, measuredCpuMillicores === null ? 0 : (measuredCpuMillicores / replicas) * 1.3);
    const capacityMemoryMiB = Math.max(memoryRequestMiB, measuredMemoryMiB === null ? 0 : (measuredMemoryMiB / replicas) * 1.3);
    const selectedInstance = Object.entries(AWS_COST_REFERENCE.instances)
        .find(([, candidate]) => candidate.vcpu * 1000 * AWS_COST_REFERENCE.allocatableFraction >= capacityCpuMillicores &&
            candidate.memoryGiB * 1024 * AWS_COST_REFERENCE.allocatableFraction >= capacityMemoryMiB);
    const instanceType = requestedInstanceType === "auto" ? selectedInstance?.[0] : requestedInstanceType;
    const instance = AWS_COST_REFERENCE.instances[instanceType];
    if (!instance) {
        return res.status(400).json({
            success: false,
            message: `Unsupported instanceType. Choose one of: ${Object.keys(AWS_COST_REFERENCE.instances).join(", ")}.`
        });
    }

    // Reserve 20% of node capacity for kube/system overhead. Capacity demand is
    // derived separately from requests and, when available, observed load-test/live use.
    const usableCpuMillicores = instance.vcpu * 1000 * AWS_COST_REFERENCE.allocatableFraction;
    const usableMemoryMiB = instance.memoryGiB * 1024 * AWS_COST_REFERENCE.allocatableFraction;
    const podsPerNodeByCpu = Math.floor(usableCpuMillicores / capacityCpuMillicores);
    const podsPerNodeByMemory = Math.floor(usableMemoryMiB / capacityMemoryMiB);
    const estimatedPodsPerNode = Math.min(podsPerNodeByCpu, podsPerNodeByMemory);

    if (estimatedPodsPerNode < 1) {
        return res.status(400).json({
            success: false,
            message: `${instanceType} is too small for one pod at the specified CPU and memory requests. Choose a larger instance or reduce requests.`
        });
    }

    const recommendedNodes = Math.ceil(replicas / estimatedPodsPerNode);
    const clusterHourly = supportTier === "extended"
        ? AWS_COST_REFERENCE.eksExtendedHourly
        : AWS_COST_REFERENCE.eksStandardHourly;
    const ec2Hourly = recommendedNodes * instance.hourly;
    const storageMonthly = recommendedNodes * storageGiBPerNode * AWS_COST_REFERENCE.ebsGp3PerGiBMonth;
    const computeMonthly = ec2Hourly * AWS_COST_REFERENCE.hoursPerMonth;
    const eksMonthly = clusterHourly * AWS_COST_REFERENCE.hoursPerMonth;
    const totalMonthly = computeMonthly + eksMonthly + storageMonthly;

    return res.json({
        success: true,
        estimate: {
            provider: "AWS",
            region: AWS_COST_REFERENCE.region,
            currency: "USD",
            instanceType,
            replicas,
            cpuRequestMillicores,
            memoryRequestMiB,
            capacityCpuMillicores: Number(capacityCpuMillicores.toFixed(2)),
            capacityMemoryMiB: Number(capacityMemoryMiB.toFixed(2)),
            supportTier,
            hoursPerMonth: AWS_COST_REFERENCE.hoursPerMonth,
            recommendedNodes,
            estimatedPodsPerNode,
            instanceVcpu: instance.vcpu,
            instanceMemoryGiB: instance.memoryGiB,
            rates: {
                ec2HourlyPerNode: instance.hourly,
                eksHourly: clusterHourly,
                ebsGp3PerGiBMonth: AWS_COST_REFERENCE.ebsGp3PerGiBMonth
            },
            breakdown: {
                ec2Monthly: Number(computeMonthly.toFixed(2)),
                eksClusterMonthly: Number(eksMonthly.toFixed(2)),
                storageMonthly: Number(storageMonthly.toFixed(2))
            },
            totalHourly: Number((ec2Hourly + clusterHourly).toFixed(4)),
            totalMonthly: Number(totalMonthly.toFixed(2)),
            totalYearly: Number((totalMonthly * 12).toFixed(2)),
            inputs: {
                kubernetesConfiguration: kubernetesResources && {
                    replicas: kubernetesResources.replicas,
                    requests: kubernetesResources.requests,
                    limits: kubernetesResources.limits
                },
                runtimeMeasurements: measuredCpuMillicores !== null && measuredMemoryMiB !== null ? {
                    cpuMillicoresTotal: Number(measuredCpuMillicores.toFixed(2)),
                    memoryMiBTotal: Number(measuredMemoryMiB.toFixed(2)),
                    liveCpuMillicores: Number(liveCpuMillicores.toFixed(2)),
                    liveMemoryMiB: Number(liveMemoryMiB.toFixed(2)),
                    loadTestPeakCpuMillicores: Number(loadCpuPeak.toFixed(2)),
                    loadTestPeakMemoryMiB: Number(loadMemoryPeak.toFixed(2)),
                    status: "measured"
                } : { status: "unavailable" },
                loadTests: loadTests.map((entry) => ({ completedAt: entry.completedAt, ...(entry.loadTest || entry), resources: entry.resources })),
                telemetry: {
                    monitoring: {
                        ready: monitoring?.ready ?? false,
                        liveCpuMillicores: Number(liveCpuMillicores.toFixed(2)),
                        liveMemoryMiB: Number(liveMemoryMiB.toFixed(2))
                    },
                    loadTesting: {
                        count: loadTests.length,
                        peakCpuMillicores: Number(loadCpuPeak.toFixed(2)),
                        peakMemoryMiB: Number(loadMemoryPeak.toFixed(2))
                    }
                },
                warnings: inputWarnings
            },
            assumptions: [
                "730 hours per month.",
                "Linux EC2 On-Demand reference pricing for us-east-1.",
                "20% of each node's CPU and memory is reserved for Kubernetes/system overhead.",
                "Node sizing uses the greater of Kubernetes requests and observed per-pod use with 30% runtime headroom when measurements are available.",
                "Includes EKS cluster fee, EC2 worker nodes, and estimated gp3 storage only.",
                "Excludes load balancers, NAT Gateway, data transfer, public IPv4, taxes, support plans, discounts, and CPU-credit overages."
            ],
            pricingSources: {
                eks: "https://aws.amazon.com/eks/pricing/",
                ec2: "https://aws.amazon.com/ec2/instance-types/t3/",
                priceCalculator: "https://calculator.aws/"
            }
        }
    });
});


// --------------------------------------------------
// Start server
// --------------------------------------------------

ensureKubernetesProxy().catch((error) => {
    console.warn("Unable to start the Kubernetes API proxy:", error.message);
});

app.listen(PORT, () => {

    console.log(
        `CDDS backend running on port ${PORT}`
    );

});
