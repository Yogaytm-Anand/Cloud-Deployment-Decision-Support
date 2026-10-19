const { exec, spawn, execFile } = require("child_process");
const express = require("express");
const simpleGit = require("simple-git");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { performance } = require("perf_hooks");
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://127.0.0.1:9090";
const KUBERNETES_PROXY_URL = process.env.KUBERNETES_PROXY_URL || "http://127.0.0.1:50527";
const PROMETHEUS_KUBERNETES_SERVICE_PATH = "/api/v1/namespaces/monitoring/services/monitoring-kube-prometheus-prometheus:9090/proxy";
const KUBERNETES_PROXY_AUTOSTART = process.env.KUBERNETES_PROXY_AUTOSTART !== "false";
const RESPONSE_TIME_TARGET_MS = 500;
const MAX_PROBE_HISTORY = 60;
const probeHistory = new Map();
let loadTestRunning = false;

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

    const proxy = spawn(
        "kubectl",
        [
            "proxy",
            `--port=${port}`,
            "--address=127.0.0.1",
            "--accept-hosts=^127\\.0\\.0\\.1$,^localhost$"
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

async function queryPrometheus(query, { signal } = {}) {
    const encodedQuery = encodeURIComponent(query);
    const url = `${PROMETHEUS_URL.replace(/\/+$/, "")}/api/v1/query?query=${encodedQuery}`;
    const fetchWithTimeout = async (targetUrl, timeoutMs = 5000) => {
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
    };
    let response;
    try {
        response = await fetchWithTimeout(url);
    } catch (directError) {
        if (signal?.aborted) throw directError;
        const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
        let directIsLocal = false;
        try {
            directIsLocal = localHosts.has(new URL(PROMETHEUS_URL).hostname);
        } catch {
            // The configured URL is invalid; keep the original request error below.
        }
        if (!directIsLocal) {
            throw new Error(`Prometheus request failed at ${PROMETHEUS_URL}: ${directError.message}`, { cause: directError });
        }

        const proxyBase = KUBERNETES_PROXY_URL.replace(/\/+$/, "");
        const proxyUrl = `${proxyBase}${PROMETHEUS_KUBERNETES_SERVICE_PATH}/api/v1/query?query=${encodedQuery}`;
        try {
            // A Prometheus query through the Kubernetes API proxy is slower than a local port-forward.
            response = await fetchWithTimeout(proxyUrl, 15000);
        } catch (proxyError) {
            const directReason = directError.cause?.code || directError.message;
            const proxyReason = proxyError.cause?.code || proxyError.message;
            throw new Error(
                `Prometheus is unreachable at ${PROMETHEUS_URL} (${directReason}) and through the Kubernetes Service proxy (${proxyReason}).`,
                { cause: proxyError }
            );
        }
    }

    if (!response.ok) {
        throw new Error(`Prometheus request failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "success") {
        throw new Error(data.error || "Prometheus query failed");
    }

    return data.data;
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

async function runK6Test(targetUrl, vus, duration, lifecycle = {}) {
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
            const child = execFile("k6", ["run", `--summary-export=${summaryPath}`, scriptPath], {
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

    if (!jobId) {
        return res.status(400).json({
            success: false,
            message: "jobId is required"
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
            queryPrometheus(cpuQuery),
            queryPrometheus(memoryQuery),
            queryPrometheus(cpuLimitQuery),
            queryPrometheus(memoryLimitQuery),
            probeDeployedService(jobId)
        ]);

        const cpuResult = cpuData.result[0];
        const memoryResult = memoryData.result[0];
        const cpuLimitResult = cpuLimitData.result[0];
        const memoryLimitResult = memoryLimitData.result[0];

        const cpu = cpuResult
            ? Number(cpuResult.value[1])
            : null;

        const memoryBytes = memoryResult
            ? Number(memoryResult.value[1])
            : null;

        const cpuLimitCores = cpuLimitResult
            ? Number(cpuLimitResult.value[1])
            : null;

        const memoryLimitBytes = memoryLimitResult
            ? Number(memoryLimitResult.value[1])
            : null;

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
            memoryMiB: memoryBytes
                ? Number(
                    (memoryBytes / 1024 / 1024).toFixed(2)
                  )
                : null,
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
        return res.json({
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
        });
    } catch (error) {
        console.error("Load test failed:", error.message);
        const status = error.status || (error.message.startsWith("k6 test failed:") ? 502 : 503);
        return res.status(status).json({ success: false, jobId, message: error.message });
    } finally {
        loadTestRunning = false;
    }
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
