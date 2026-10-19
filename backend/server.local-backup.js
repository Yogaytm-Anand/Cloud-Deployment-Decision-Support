const { exec } = require("child_process");
const express = require("express");
const simpleGit = require("simple-git");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROMETHEUS_URL = "http://localhost:9090";

const app = express();
app.use(express.json());

const PORT = 4000;


// ==================================================
// PROMETHEUS QUERY
// ==================================================

async function queryPrometheus(query) {

    const url =
        `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Prometheus request failed: ${response.status}`
        );
    }

    const data = await response.json();

    if (data.status !== "success") {
        throw new Error(
            data.error || "Prometheus query failed"
        );
    }

    return data.data;
}


// ==================================================
// RUN TERMINAL COMMAND
// ==================================================

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


// ==================================================
// GENERATE KUBERNETES FILES
// ==================================================

function generateKubernetesFiles(
    repoPath,
    imageName,
    jobId
) {

    const kubernetesPath = path.join(
        repoPath,
        "kubernetes"
    );


    // Create kubernetes folder

    if (!fs.existsSync(kubernetesPath)) {

        fs.mkdirSync(
            kubernetesPath
        );

    }


    // --------------------------------------------------
    // Kubernetes Deployment
    // --------------------------------------------------

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


    // --------------------------------------------------
    // Kubernetes Service
    // --------------------------------------------------

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


    // Write deployment.yaml

    fs.writeFileSync(

        path.join(
            kubernetesPath,
            "deployment.yaml"
        ),

        deploymentYaml.trim()

    );


    // Write service.yaml

    fs.writeFileSync(

        path.join(
            kubernetesPath,
            "service.yaml"
        ),

        serviceYaml.trim()

    );


    return {

        deployment:
            "deployment.yaml",

        service:
            "service.yaml"

    };

}


// ==================================================
// DEPLOY APPLICATION TO KUBERNETES
// ==================================================

async function deployToKubernetes(
    imageName,
    repoPath,
    jobId
) {

    console.log(
        `Deploying ${imageName} to Kubernetes...`
    );


    const deploymentPath =
        path.join(
            repoPath,
            "kubernetes",
            "deployment.yaml"
        );


    const servicePath =
        path.join(
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


    // Make image available to Minikube

    await runCommand(
        `minikube image load ${imageName}`
    );


    // Deploy application

    await runCommand(
        `kubectl apply -f "${deploymentPath}"`
    );


    // Deploy service

    await runCommand(
        `kubectl apply -f "${servicePath}"`
    );


    // Wait for deployment

    await runCommand(
        `kubectl rollout status deployment/${jobId} --timeout=120s`
    );


    console.log(
        "Kubernetes deployment successful"
    );


    return {

        success: true,

        deployment:
            jobId,

        service:
            `${jobId}-service`,

        image:
            imageName

    };

}


// ==================================================
// GET KUBERNETES SERVICE URL
// ==================================================

async function getServiceUrl(jobId) {

    console.log(
        `Finding Kubernetes service for ${jobId}...`
    );


    // Get Minikube IP

    const minikubeResult =
        await runCommand(
            "minikube ip"
        );

    const minikubeIp =
        minikubeResult.stdout.trim();


    // Get NodePort

    const serviceResult =
        await runCommand(

            `kubectl get service ${jobId}-service ` +
            `-o jsonpath="{.spec.ports[0].nodePort}"`

        );


    const nodePort =
        serviceResult.stdout
            .trim()
            .replace(/"/g, "");


    if (!nodePort) {

        throw new Error(
            "Could not determine Kubernetes NodePort"
        );

    }


    const targetUrl =
        `http://${minikubeIp}:${nodePort}`;


    console.log(
        `Target URL: ${targetUrl}`
    );


    return targetUrl;

}


// ==================================================
// RUN K6 LOAD TEST
// ==================================================

function runK6Test(
    targetUrl,
    vus,
    duration
) {

    return new Promise((resolve, reject) => {


        // --------------------------------------------------
        // Generate temporary k6 script
        // --------------------------------------------------

        const script = `

import http from 'k6/http';

import {
    check
} from 'k6';


export const options = {

    vus: ${vus},

    duration: '${duration}',

};


export default function () {

    const response =
        http.get('${targetUrl}/health');


    check(
        response,
        {

            'status is 200':
                (r) => r.status === 200

        }
    );

}

`;


        const scriptPath =
            path.join(

                os.tmpdir(),

                `cdds-loadtest-${Date.now()}.js`

            );


        const summaryPath =
            `${scriptPath}.json`;


        fs.writeFileSync(
            scriptPath,
            script
        );


        // --------------------------------------------------
        // Run k6
        // --------------------------------------------------

        exec(

            `k6 run --summary-export="${summaryPath}" "${scriptPath}"`,

            (error, stdout, stderr) => {


                // Remove script

                if (
                    fs.existsSync(
                        scriptPath
                    )
                ) {

                    fs.unlinkSync(
                        scriptPath
                    );

                }


                if (error) {

                    reject({

                        error:
                            error.message,

                        stdout,

                        stderr

                    });

                    return;

                }


                try {


                    // Read k6 summary

                    const summary =
                        JSON.parse(

                            fs.readFileSync(
                                summaryPath,
                                "utf8"
                            )

                        );


                    // Remove summary file

                    if (
                        fs.existsSync(
                            summaryPath
                        )
                    ) {

                        fs.unlinkSync(
                            summaryPath
                        );

                    }


                    resolve({

                        summary,

                        stdout

                    });


                }
                catch (parseError) {


                    if (
                        fs.existsSync(
                            summaryPath
                        )
                    ) {

                        fs.unlinkSync(
                            summaryPath
                        );

                    }


                    reject({

                        error:
                            parseError.message,

                        stdout,

                        stderr

                    });

                }

            }

        );

    });

}


// ==================================================
// EXTRACT K6 METRICS
// ==================================================

function extractK6Metrics(summary) {

    const metrics =
        summary.metrics || {};


    const requests =
        metrics.http_reqs?.values?.count || 0;


    const requestsPerSecond =
        metrics.http_reqs?.values?.rate || 0;


    const avgResponseTime =
        metrics.http_req_duration?.values?.avg || 0;


    const p95ResponseTime =
        metrics.http_req_duration?.values?.["p(95)"] || 0;


    const maxResponseTime =
        metrics.http_req_duration?.values?.max || 0;


    const failedRequests =
        metrics.http_req_failed?.values?.rate || 0;


    return {

        requests,

        requestsPerSecond:
            Number(
                requestsPerSecond.toFixed(2)
            ),

        avgResponseTime:
            Number(
                avgResponseTime.toFixed(2)
            ),

        p95ResponseTime:
            Number(
                p95ResponseTime.toFixed(2)
            ),

        maxResponseTime:
            Number(
                maxResponseTime.toFixed(2)
            ),

        errorRate:
            Number(
                (failedRequests * 100).toFixed(2)
            )

    };

}


// ==================================================
// GET PROMETHEUS RESOURCE METRICS
// ==================================================

async function getPrometheusMetrics(jobId) {

    const podPattern =
        `${jobId}-.*`;


    // --------------------------------------------------
    // CPU
    // --------------------------------------------------

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


    // --------------------------------------------------
    // Memory
    // --------------------------------------------------

    const memoryQuery = `

container_memory_working_set_bytes{

    namespace="default",

    pod=~"${podPattern}",

    container!="POD",

    container!=""

}

`;


    const cpuData =
        await queryPrometheus(
            cpuQuery
        );


    const memoryData =
        await queryPrometheus(
            memoryQuery
        );


    const cpuResult =
        cpuData.result[0];


    const memoryResult =
        memoryData.result[0];


    const cpu =
        cpuResult
            ? Number(
                cpuResult.value[1]
              )
            : null;


    const memoryBytes =
        memoryResult
            ? Number(
                memoryResult.value[1]
              )
            : null;


    return {

        pod:
            cpuResult?.metric?.pod ||
            memoryResult?.metric?.pod ||
            null,

        cpu,

        memoryBytes,

        memoryMiB:

            memoryBytes !== null

                ? Number(

                    (
                        memoryBytes /
                        1024 /
                        1024

                    ).toFixed(2)

                  )

                : null

    };

}


// ==================================================
// MAIN CDDS ANALYZE API
// ==================================================

app.post(
    "/api/analyze",
    async (req, res) => {


        const {
            repoUrl
        } = req.body;


        // --------------------------------------------------
        // Validate URL
        // --------------------------------------------------

        if (!repoUrl) {

            return res.status(400).json({

                success: false,

                message:
                    "GitHub repository URL is required"

            });

        }


        if (
            !repoUrl.startsWith(
                "https://github.com/"
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Only GitHub repositories are supported"

            });

        }


        // --------------------------------------------------
        // Create unique job
        // --------------------------------------------------

        const jobId =
            `cdds-${Date.now()}`;


        const repoPath =
            path.join(
                os.tmpdir(),
                jobId
            );


        try {


            // ==================================================
            // 1. CLONE REPOSITORY
            // ==================================================

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


            // ==================================================
            // 2. CHECK DOCKERFILE
            // ==================================================

            const dockerfilePath =
                path.join(
                    repoPath,
                    "Dockerfile"
                );


            const hasDockerfile =
                fs.existsSync(
                    dockerfilePath
                );


            // ==================================================
            // 3. BUILD DOCKER IMAGE
            // ==================================================

            let dockerBuild = {

                attempted: false,

                success: false,

                image: null

            };


            if (hasDockerfile) {


                const imageName =
                    `cdds-app:${jobId}`;


                dockerBuild.attempted =
                    true;


                dockerBuild.image =
                    imageName;


                try {


                    console.log(
                        `Building Docker image: ${imageName}`
                    );


                    await runCommand(

                        `docker build -t ${imageName} .`,

                        repoPath

                    );


                    dockerBuild.success =
                        true;


                    console.log(
                        `Docker image built successfully: ${imageName}`
                    );


                }
                catch (error) {


                    console.error(
                        "Docker build failed:",
                        error
                    );


                    dockerBuild.success =
                        false;


                    dockerBuild.error =
                        error.stderr ||
                        error.error;

                }

            }


            // ==================================================
            // 4. GENERATE KUBERNETES FILES
            // ==================================================

            let kubernetesGeneration = {

                attempted: false,

                success: false,

                files: []

            };


            if (
                dockerBuild.success
            ) {


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


                }
                catch (error) {


                    kubernetesGeneration = {

                        attempted: true,

                        success: false,

                        error:
                            error.message

                    };

                }

            }


            // ==================================================
            // 5. DEPLOY TO KUBERNETES
            // ==================================================

            let kubernetesDeployment = {

                attempted: false,

                success: false

            };


            if (

                dockerBuild.success &&

                kubernetesGeneration.success

            ) {


                kubernetesDeployment.attempted =
                    true;


                try {


                    kubernetesDeployment =
                        await deployToKubernetes(

                            dockerBuild.image,

                            repoPath,

                            jobId

                        );


                }
                catch (error) {


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


            // ==================================================
            // 6. FINAL RESPONSE
            // ==================================================

            res.json({

                success: true,

                jobId,

                repository:
                    repoUrl,

                validation: {

                    dockerfile:
                        hasDockerfile

                },

                dockerBuild,

                kubernetesGeneration,

                kubernetesDeployment

            });


        }
        catch (error) {


            console.error(error);


            res.status(500).json({

                success: false,

                message:
                    "Repository analysis failed",

                error:
                    error.message

            });

        }

    }
);


// ==================================================
// HEALTH CHECK
// ==================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            status:
                "Backend running"

        });

    }
);


// ==================================================
// BASIC PROMETHEUS METRICS API
// ==================================================

app.get(
    "/api/metrics",
    async (req, res) => {


        const {
            jobId
        } = req.query;


        if (!jobId) {

            return res.status(400).json({

                success: false,

                message:
                    "jobId is required"

            });

        }


        try {


            const metrics =
                await getPrometheusMetrics(
                    jobId
                );


            res.json({

                success: true,

                jobId,

                ...metrics

            });


        }
        catch (error) {


            console.error(
                "Prometheus error:",
                error.message
            );


            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ==================================================
// INTEGRATED LOAD TEST API
// ==================================================

app.post(
    "/api/load-test",
    async (req, res) => {


        const {

            jobId,

            loadLevel,

            vus,

            duration

        } = req.body;


        // --------------------------------------------------
        // Validate jobId
        // --------------------------------------------------

        if (!jobId) {

            return res.status(400).json({

                success: false,

                message:
                    "jobId is required"

            });

        }


        // --------------------------------------------------
        // Load presets
        // --------------------------------------------------

        const presets = {

            light: {

                vus: 10,

                duration: "20s"

            },

            medium: {

                vus: 50,

                duration: "30s"

            },

            heavy: {

                vus: 100,

                duration: "30s"

            }

        };


        let finalVus;

        let finalDuration;


        // --------------------------------------------------
        // Custom load
        // --------------------------------------------------

        if (
            loadLevel === "custom"
        ) {


            finalVus =
                vus || 10;


            finalDuration =
                duration || "30s";


        }

        // --------------------------------------------------
        // Preset load
        // --------------------------------------------------

        else {


            const selectedPreset =
                presets[
                    loadLevel || "light"
                ];


            if (!selectedPreset) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid loadLevel. Use light, medium, heavy or custom."

                });

            }


            finalVus =
                selectedPreset.vus;


            finalDuration =
                selectedPreset.duration;

        }


        try {


            console.log(
                "================================"
            );


            console.log(
                "Starting CDDS load test"
            );


            console.log(
                `Job ID: ${jobId}`
            );


            console.log(
                `Load level: ${loadLevel || "light"}`
            );


            console.log(
                `VUs: ${finalVus}`
            );


            console.log(
                `Duration: ${finalDuration}`
            );


            // ==================================================
            // 1. FIND KUBERNETES SERVICE
            // ==================================================

            const targetUrl =
                await getServiceUrl(
                    jobId
                );


            // ==================================================
            // 2. RUN K6
            // ==================================================

            const result =
                await runK6Test(

                    targetUrl,

                    finalVus,

                    finalDuration

                );


            // ==================================================
            // 3. EXTRACT K6 METRICS
            // ==================================================

            const loadMetrics =
                extractK6Metrics(
                    result.summary
                );


            // ==================================================
            // 4. GET PROMETHEUS METRICS
            // ==================================================

            const resourceMetrics =
                await getPrometheusMetrics(
                    jobId
                );


            // ==================================================
            // 5. RETURN COMBINED RESULT
            // ==================================================

            res.json({

                success: true,

                jobId,

                targetUrl,

                loadTest: {

                    level:
                        loadLevel || "light",

                    vus:
                        finalVus,

                    duration:
                        finalDuration,

                    ...loadMetrics

                },

                resources:
                    resourceMetrics

            });


            console.log(
                "CDDS load test completed"
            );


            console.log(
                "================================"
            );


        }
        catch (error) {


            console.error(
                "Load test failed:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "Load test failed",

                error:
                    error.error ||
                    error.message,

                output:
                    error.stdout,

                stderr:
                    error.stderr

            });

        }

    }
);


// ==================================================
// START SERVER
// ==================================================

app.listen(
    PORT,
    () => {

        console.log(
            `CDDS backend running on port ${PORT}`
        );

    }
);