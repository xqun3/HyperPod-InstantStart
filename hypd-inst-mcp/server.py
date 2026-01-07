#!/usr/bin/env python3
"""
HyperPod InstantStart MCP Server
"""

from mcp.server import FastMCP
import httpx
import json
import subprocess

mcp = FastMCP(
    name="hyperpod-manager",
    instructions="HyperPod InstantStart 集群管理工具，提供集群创建、推理部署、训练作业等功能"
)

BASE_URL = "http://localhost:3001"

# ============ 集群管理工具 ============

@mcp.tool()
async def cluster_get_status() -> str:
    """获取当前集群状态，包括节点、GPU、HyperPod 实例组等信息"""
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{BASE_URL}/api/cluster-status")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_create_eks(clusterTag: str = None, region: str = None, vpcCidr: str = None) -> str:
    """创建新的 EKS 集群（需要 8-12 分钟）
    
    Args:
        clusterTag: 集群标签（可选，默认自动生成如 hypd-1222）
        region: AWS 区域（可选，默认使用当前配置的区域）
        vpcCidr: VPC CIDR 块（可选，默认自动生成）
    """
    try:
        # 如果没有指定 region，从后端获取当前 region
        if not region:
            async with httpx.AsyncClient() as client:
                region_resp = await client.get(f"{BASE_URL}/api/aws/current-region")
                if region_resp.status_code == 200:
                    region_data = region_resp.json()
                    region = region_data.get("region")
        
        if not region:
            return json.dumps({
                "success": False,
                "error": "Cannot determine AWS region. Please specify region parameter."
            }, indent=2, ensure_ascii=False)
        
        # 如果没有指定 clusterTag，生成默认值
        if not clusterTag:
            from datetime import datetime
            timestamp = datetime.now().strftime("%m%d")
            clusterTag = f"hypd-{timestamp}"
        
        payload = {"clusterTag": clusterTag, "region": region}
        if vpcCidr:
            payload["vpcCidr"] = vpcCidr
        
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/create-eks", json=payload)
            response.raise_for_status()
            result = response.json()
            
            if result.get("success"):
                return json.dumps({
                    "success": True,
                    "message": f"✅ EKS cluster creation started",
                    "clusterTag": clusterTag,
                    "region": region,
                    "estimatedTime": "8-12 minutes",
                    "tip": "Use 'cluster_get_status' to monitor progress"
                }, indent=2, ensure_ascii=False)
            else:
                return json.dumps(result, indent=2, ensure_ascii=False)
                
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_list_all() -> str:
    """列出所有已管理的集群"""
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{BASE_URL}/api/multi-cluster/list")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_switch(clusterTag: str) -> str:
    """切换当前操作的集群
    
    Args:
        clusterTag: 目标集群标签
    """
    async with httpx.AsyncClient() as client:
        response = await client.post(f"{BASE_URL}/api/multi-cluster/switch", json={"clusterTag": clusterTag})
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_nodegroup_scale(name: str, minSize: int, maxSize: int, desiredSize: int) -> str:
    """扩缩容 EKS 节点组
    
    Args:
        name: 节点组名称
        minSize: 最小节点数
        maxSize: 最大节点数
        desiredSize: 期望节点数
    """
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.put(
            f"{BASE_URL}/api/cluster/nodegroups/{name}/scale",
            json={"minSize": minSize, "maxSize": maxSize, "desiredSize": desiredSize}
        )
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_nodegroup_delete(nodeGroupName: str) -> str:
    """删除 EKS 节点组
    
    Args:
        nodeGroupName: 节点组名称
    """
    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.delete(f"{BASE_URL}/api/cluster/nodegroup/{nodeGroupName}")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

# ============ S3 存储管理工具 ============

@mcp.tool()
async def s3_storage_list_contents(storage: str = None) -> str:
    """列出 S3 存储桶中的文件和文件夹（模型文件等）
    
    Args:
        storage: PVC 存储名称（可选，默认使用 s3-claim）
    """
    async with httpx.AsyncClient() as client:
        params = {"storage": storage} if storage else {}
        response = await client.get(f"{BASE_URL}/api/s3-storage", params=params)
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

# ============ 模型下载工具 ============

@mcp.tool()
async def model_download_enhanced(
    modelId: str,
    s3Storage: str = None,
    cpu: str = "4",
    memory: str = "16",
    hfToken: str = None
) -> str:
    """从 HuggingFace 下载模型到集群存储
    
    Args:
        modelId: HuggingFace 模型 ID，如 Qwen/Qwen2.5-7B-Instruct
        s3Storage: S3 存储桶名称（可选，默认使用集群默认存储桶）
        cpu: CPU 核心数（默认 4）
        memory: 内存大小 GB（默认 16）
        hfToken: HuggingFace Token（可选，用于私有模型）
    """
    try:
        # 如果没有指定 s3Storage，尝试获取默认存储桶
        if not s3Storage:
            async with httpx.AsyncClient() as client:
                storage_resp = await client.get(f"{BASE_URL}/api/s3-storages")
                if storage_resp.status_code == 200:
                    storages = storage_resp.json().get("storages", [])
                    if storages:
                        s3Storage = storages[0].get("name", "")
        
        if not s3Storage:
            return json.dumps({
                "success": False,
                "error": "No S3 storage available. Please specify s3Storage parameter."
            }, indent=2, ensure_ascii=False)
        
        payload = {
            "modelId": modelId,
            "s3Storage": s3Storage,
            "resources": {
                "cpu": cpu,
                "memory": memory
            }
        }
        if hfToken:
            payload["hfToken"] = hfToken
        
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/download-model-enhanced", json=payload)
            response.raise_for_status()
            result = response.json()
            
            if result.get("success"):
                job_name = result.get("jobName", "")
                k8s_job_name = f"model-download-job-{job_name}" if job_name else ""
                return json.dumps({
                    "success": True,
                    "message": f"✅ Model download started for {modelId}",
                    "jobName": k8s_job_name,
                    "s3Storage": s3Storage,
                    "resources": {
                        "cpu": f"{cpu} cores",
                        "memory": f"{memory}GB"
                    },
                    "tip": f"Monitor: job_get_status {k8s_job_name}" if k8s_job_name else "Check: job_list_all"
                }, indent=2, ensure_ascii=False)
            else:
                return json.dumps({
                    "success": False,
                    "error": result.get("error", "Unknown error")
                }, indent=2, ensure_ascii=False)
                
    except httpx.HTTPError as e:
        return json.dumps({
            "success": False,
            "error": f"HTTP Error: {str(e)}"
        }, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"Error: {str(e)}"
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def job_get_status(jobName: str) -> str:
    """查询 Kubernetes Job 的状态（用于监控模型下载等任务）
    
    Args:
        jobName: Job 名称，如 model-download-qwen-qwen2-5-7b-instruct
    
    Returns:
        Job 状态信息，包括运行状态、成功/失败数量、完成时间等
    """
    try:
        # 执行 kubectl 命令获取 Job 状态
        result = subprocess.run(
            ["kubectl", "get", "job", jobName, "-o", "json"],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            return json.dumps({
                "success": False,
                "error": f"Job not found or error: {result.stderr}"
            }, indent=2, ensure_ascii=False)
        
        # 解析 Job 状态
        job_data = json.loads(result.stdout)
        status = job_data.get("status", {})
        metadata = job_data.get("metadata", {})
        
        # 判断任务状态
        succeeded = status.get("succeeded", 0)
        failed = status.get("failed", 0)
        active = status.get("active", 0)
        
        if succeeded > 0:
            overall_status = "✅ Completed Successfully"
        elif failed > 0:
            overall_status = "❌ Failed"
        elif active > 0:
            overall_status = "🔄 Running"
        else:
            overall_status = "⏳ Pending"
        
        return json.dumps({
            "success": True,
            "jobName": jobName,
            "overallStatus": overall_status,
            "details": {
                "active": active,
                "succeeded": succeeded,
                "failed": failed,
                "completionTime": status.get("completionTime"),
                "startTime": status.get("startTime"),
                "creationTime": metadata.get("creationTimestamp")
            },
            "conditions": status.get("conditions", [])
        }, indent=2, ensure_ascii=False)
        
    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "Command timeout"
        }, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def job_list_all() -> str:
    """列出所有 Kubernetes Jobs（包括模型下载任务）
    
    Returns:
        所有 Job 的列表，包括名称、状态、创建时间等
    """
    try:
        # 执行 kubectl 命令获取所有 Jobs
        result = subprocess.run(
            ["kubectl", "get", "jobs", "-o", "json"],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            return json.dumps({
                "success": False,
                "error": f"Failed to list jobs: {result.stderr}"
            }, indent=2, ensure_ascii=False)
        
        # 解析 Jobs 列表
        jobs_data = json.loads(result.stdout)
        jobs = []
        
        for item in jobs_data.get("items", []):
            metadata = item.get("metadata", {})
            status = item.get("status", {})
            
            # 判断状态
            succeeded = status.get("succeeded", 0)
            failed = status.get("failed", 0)
            active = status.get("active", 0)
            
            if succeeded > 0:
                job_status = "✅ Completed"
            elif failed > 0:
                job_status = "❌ Failed"
            elif active > 0:
                job_status = "🔄 Running"
            else:
                job_status = "⏳ Pending"
            
            jobs.append({
                "name": metadata.get("name"),
                "namespace": metadata.get("namespace", "default"),
                "status": job_status,
                "creationTime": metadata.get("creationTimestamp"),
                "completionTime": status.get("completionTime"),
                "active": active,
                "succeeded": succeeded,
                "failed": failed
            })
        
        return json.dumps({
            "success": True,
            "jobs": jobs,
            "total": len(jobs)
        }, indent=2, ensure_ascii=False)
        
    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "Command timeout"
        }, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

# ============ 推理调用工具 ============

@mcp.tool()
async def inference_list_services() -> str:
    """列出所有推理服务（包括内部 ClusterIP 和外部 LoadBalancer）"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{BASE_URL}/api/v2/app-status")
            response.raise_for_status()
            data = response.json()
            
            services = data.get("rawServices", data.get("services", []))
            
            # 分类服务
            clusterip_services = []
            loadbalancer_services = []
            
            for service in services:
                metadata = service.get("metadata", {})
                spec = service.get("spec", {})
                status = service.get("status", {})
                
                name = metadata.get("name", "")
                namespace = metadata.get("namespace", "default")
                service_type = spec.get("type", "")
                
                # 排除系统服务
                if name == "kubernetes":
                    continue
                
                port = spec.get("ports", [{}])[0].get("port", 8000)
                
                if service_type == "ClusterIP":
                    cluster_ip = spec.get("clusterIP", "")
                    clusterip_services.append({
                        "name": name,
                        "namespace": namespace,
                        "url": f"http://{cluster_ip}:{port}",
                        "port": port
                    })
                elif service_type == "LoadBalancer":
                    ingress = status.get("loadBalancer", {}).get("ingress", [])
                    if ingress:
                        host = ingress[0].get("hostname") or ingress[0].get("ip")
                        url = f"http://{host}:{port}"
                        status_text = "ready"
                    else:
                        url = "pending"
                        status_text = "pending"
                    
                    loadbalancer_services.append({
                        "name": name,
                        "namespace": namespace,
                        "url": url,
                        "port": port,
                        "status": status_text
                    })
            
            return json.dumps({
                "success": True,
                "clusterIP": {
                    "count": len(clusterip_services),
                    "services": clusterip_services,
                    "note": "Internal access only (within cluster)"
                },
                "loadBalancer": {
                    "count": len(loadbalancer_services),
                    "services": loadbalancer_services,
                    "note": "External access available"
                },
                "total": len(clusterip_services) + len(loadbalancer_services)
            }, indent=2, ensure_ascii=False)
            
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def inference_list_public_services() -> str:
    """列出可公开访问的推理服务（仅 LoadBalancer 类型）"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{BASE_URL}/api/v2/app-status")
            response.raise_for_status()
            data = response.json()
            
            services = data.get("rawServices", data.get("services", []))
            public_services = []
            
            for service in services:
                metadata = service.get("metadata", {})
                spec = service.get("spec", {})
                status = service.get("status", {})
                
                name = metadata.get("name", "")
                namespace = metadata.get("namespace", "default")
                
                if name == "kubernetes":
                    continue
                
                if spec.get("type") == "LoadBalancer":
                    port = spec.get("ports", [{}])[0].get("port", 8000)
                    ingress = status.get("loadBalancer", {}).get("ingress", [])
                    
                    if ingress:
                        host = ingress[0].get("hostname") or ingress[0].get("ip")
                        public_services.append({
                            "name": name,
                            "namespace": namespace,
                            "url": f"http://{host}:{port}",
                            "port": port,
                            "status": "ready"
                        })
                    else:
                        public_services.append({
                            "name": name,
                            "namespace": namespace,
                            "url": "pending",
                            "port": port,
                            "status": "pending"
                        })
            
            return json.dumps({
                "success": True,
                "services": public_services,
                "total": len(public_services)
            }, indent=2, ensure_ascii=False)
            
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def inference_call_model(
    service_name: str,
    prompt: str,
    namespace: str = "default",
    max_tokens: int = 512,
    temperature: float = 0.7,
    local_port: int = 2020
) -> str:
    """调用推理模型生成响应（支持 LoadBalancer 和 ClusterIP 服务）
    
    Args:
        service_name: 服务名称（从 inference_list_services 获取）
        prompt: 输入提示词
        namespace: 命名空间（默认 default）
        max_tokens: 最大生成 token 数（默认 512）
        temperature: 温度参数（默认 0.7）
        local_port: Port-forward 本地端口（默认 2020，仅 ClusterIP 服务需要）
    """
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            # 获取服务信息
            status_resp = await client.get(f"{BASE_URL}/api/v2/app-status")
            status_resp.raise_for_status()
            data = status_resp.json()
            services = data.get("rawServices", data.get("services", []))
            
            # 找到目标服务
            target_service = None
            for svc in services:
                if (svc.get("metadata", {}).get("name") == service_name and 
                    svc.get("metadata", {}).get("namespace") == namespace):
                    target_service = svc
                    break
            
            if not target_service:
                return json.dumps({
                    "success": False,
                    "error": f"Service {service_name} not found in namespace {namespace}"
                }, indent=2, ensure_ascii=False)
            
            service_type = target_service.get("spec", {}).get("type", "")
            service_port = target_service.get("spec", {}).get("ports", [{}])[0].get("port", 8000)
            
            # 构造请求 payload
            payload = {
                "model": "default",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": temperature
            }
            
            # 根据服务类型选择调用方式
            if service_type == "LoadBalancer":
                # LoadBalancer: 直接调用外部地址
                ingress = target_service.get("status", {}).get("loadBalancer", {}).get("ingress", [])
                if not ingress:
                    return json.dumps({
                        "success": False,
                        "error": f"LoadBalancer service {service_name} has no external endpoint (pending)"
                    }, indent=2, ensure_ascii=False)
                
                host = ingress[0].get("hostname") or ingress[0].get("ip")
                service_url = f"http://{host}:{service_port}/v1/chat/completions"
                
                proxy_resp = await client.post(
                    f"{BASE_URL}/api/proxy-request",
                    json={"url": service_url, "payload": payload, "method": "POST"}
                )
                
            elif service_type == "ClusterIP":
                # ClusterIP: 使用 port-forward
                service_url = f"http://localhost:{local_port}/v1/chat/completions"
                
                proxy_resp = await client.post(
                    f"{BASE_URL}/api/proxy-request-portforward",
                    json={
                        "url": service_url,
                        "payload": payload,
                        "method": "POST",
                        "portForward": {
                            "enabled": True,
                            "serviceName": service_name,
                            "namespace": namespace,
                            "servicePort": service_port,
                            "localPort": local_port
                        }
                    }
                )
            else:
                return json.dumps({
                    "success": False,
                    "error": f"Unsupported service type: {service_type}"
                }, indent=2, ensure_ascii=False)
            
            result = proxy_resp.json()
            
            if result.get("success"):
                response_data = result.get("data", {})
                choices = response_data.get("choices", [])
                if choices:
                    content = choices[0].get("message", {}).get("content", "")
                    return json.dumps({
                        "success": True,
                        "response": content,
                        "usage": response_data.get("usage", {}),
                        "model": response_data.get("model", "unknown"),
                        "serviceType": service_type
                    }, indent=2, ensure_ascii=False)
            
            return json.dumps({
                "success": False,
                "error": result.get("error", "No response from model"),
                "details": result.get("data", {})
            }, indent=2, ensure_ascii=False)
                
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

# ============ HyperPod 节点操作工具 ============

@mcp.tool()
async def hyperpod_node_reboot(nodeId: str) -> str:
    """重启 HyperPod 集群中的指定节点
    
    Args:
        nodeId: 节点 ID（格式：hyperpod-i-xxxxxxxxx 或 i-xxxxxxxxx）
    
    Returns:
        操作结果，包括成功状态和消息
    """
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{BASE_URL}/api/cluster/hyperpod/node/reboot",
                json={"nodeId": nodeId}
            )
            response.raise_for_status()
            result = response.json()
            
            if result.get("success"):
                return json.dumps({
                    "success": True,
                    "message": f"✅ Node {nodeId} reboot initiated successfully",
                    "nodeId": result.get("nodeId"),
                    "tip": "The node will be temporarily unavailable during reboot"
                }, indent=2, ensure_ascii=False)
            else:
                return json.dumps({
                    "success": False,
                    "error": result.get("message", "Failed to reboot node")
                }, indent=2, ensure_ascii=False)
                
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_node_replace(nodeId: str) -> str:
    """替换 HyperPod 集群中的指定节点（终止并用新实例替换）
    
    Args:
        nodeId: 节点 ID（格式：hyperpod-i-xxxxxxxxx 或 i-xxxxxxxxx）
    
    Returns:
        操作结果，包括成功状态和消息
    
    Warning:
        ⚠️ 替换节点会永久删除所有实例卷数据，请确保已备份重要数据
    """
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{BASE_URL}/api/cluster/hyperpod/node/replace",
                json={"nodeId": nodeId}
            )
            response.raise_for_status()
            result = response.json()
            
            if result.get("success"):
                return json.dumps({
                    "success": True,
                    "message": f"✅ Node {nodeId} replacement initiated successfully",
                    "nodeId": result.get("nodeId"),
                    "warning": "⚠️ All instance volumes will be permanently deleted",
                    "tip": "Ensure your data is backed up to S3 or FSx before replacement"
                }, indent=2, ensure_ascii=False)
            else:
                return json.dumps({
                    "success": False,
                    "error": result.get("message", "Failed to replace node")
                }, indent=2, ensure_ascii=False)
                
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    mcp.run(transport="stdio")
