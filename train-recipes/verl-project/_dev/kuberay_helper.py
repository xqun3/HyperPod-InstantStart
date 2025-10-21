import os
import time
import ray
import subprocess
import json

class KubeRayHelper:
    def __init__(self, cluster_name="verl-training-cluster", namespace="default"):
        self.cluster_name = cluster_name
        self.namespace = namespace
        
    def get_ray_head_service_ip(self):
        """获取Ray head service的IP地址"""
        cmd = f"kubectl get svc {self.cluster_name}-head-svc -n {self.namespace} -o jsonpath='{{.spec.clusterIP}}'"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else None
    
    def wait_for_cluster_ready(self, timeout=300):
        """等待Ray集群准备就绪"""
        print(f"Waiting for Ray cluster {self.cluster_name} to be ready...")
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            cmd = f"kubectl get raycluster {self.cluster_name} -n {self.namespace} -o jsonpath='{{.status.state}}'"
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            
            if result.returncode == 0:
                state = result.stdout.strip()
                print(f"Cluster state: {state}")
                if state == 'ready':
                    print("Ray cluster is ready!")
                    return True
            
            time.sleep(10)
        
        raise Exception(f"Ray cluster not ready within {timeout} seconds")
    
    def connect_to_ray_cluster(self):
        """连接到Ray集群"""
        head_service_ip = self.get_ray_head_service_ip()
        if not head_service_ip:
            raise Exception("Could not get Ray head service IP")
        
        ray_address = f"ray://{head_service_ip}:10001"
        print(f"Connecting to Ray cluster at: {ray_address}")
        
        if ray.is_initialized():
            ray.shutdown()
        
        ray.init(address=ray_address)
        return ray_address
