---
name: deploy-model
description: Deploy a containerized inference model (vLLM, SGLang, etc.) to the cluster. Use when user wants to deploy a model, start inference service, or serve a model.
---

## Overview

Deploy a containerized inference service by parsing the user's deployment command and calling `inference_deploy_container`.

## Step 1: Collect Information

Ask user for:
- **Deployment command** (required): the full command to run, e.g.:
  ```
  vllm serve /s3/Qwen-Qwen3-0.6B --tensor-parallel-size 1 --host 0.0.0.0 --port 8000
  ```
  ```
  python3 -m sglang.launch_server --model-path Qwen/Qwen3-0.6B --tp-size 1
  ```
- **gpuCount** (required): how many GPUs per replica
- **replicas**: how many replicas (default 1)
- **serviceType**: clusterip (default) or external (LoadBalancer)? Don't ask if user doesn't mention it.
- **instanceTypes**: which instance type(s) to schedule on — can be multiple, e.g. ml.g5.xlarge and ml.g5.2xlarge (optional). If user doesn't specify, call `cluster_get_status` to get available instance types and use only GPU instance types (ml.g*, ml.p*, g*, p*). Never schedule inference workloads on CPU-only nodes.

## Step 2: Parse Command and Infer Parameters

### Engine & Docker Image
- Command contains `vllm` → default image: `vllm/vllm-openai:latest`
- Command contains `sglang` → default image: `lmsysorg/sglang:latest`
- Otherwise → ask user for docker image

### Port
- Parse `--port N` from command → use that port
- If not found → default 8000

### Defaults (do not ask user)
- gpuMemory: -1
- cpuRequest: -1
- memoryRequest: -1
- deploymentName: auto-generated (unless user specifies)

User can override docker image if they specify one explicitly.

## Step 3: Confirm and Deploy

1. Show parsed parameters summary:
   - Docker image (inferred or user-specified)
   - Deployment command
   - GPU count × replicas
   - Port
   - Service type
   - Instance types (if any)
2. After user confirms, call `inference_deploy_container`

## Step 4: Verify

1. Call `inference_list_services` to check the new service status
2. If external, show the endpoint URL once available

## Rules

- gpuCount MUST be provided by user. Do NOT infer from tensor-parallel-size or tp-size.
- Docker image: infer from command engine type. Only ask if engine is unrecognizable.
- Port: infer from --port in command. Default 8000.
- serviceType: default clusterip. Only use external if user explicitly asks.
- Do NOT ask about gpuMemory, cpuRequest, memoryRequest, deploymentName unless user brings them up.
- Confirm parameters with user before deploying.
