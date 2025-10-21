#!/usr/bin/env python3
import os
import sys
import time
import subprocess
from kuberay_helper import KubeRayHelper

def main():
    print("=== Starting VeRL Training with KubeRay ===")
    
    # 初始化KubeRay helper
    kuberay_helper = KubeRayHelper()
    
    try:
        # 等待Ray集群准备就绪
        kuberay_helper.wait_for_cluster_ready()
        
        # 连接到Ray集群
        ray_address = kuberay_helper.connect_to_ray_cluster()
        
        # 显示集群信息
        kuberay_helper.get_cluster_info()
        
        # 设置环境变量
        os.environ['RAY_ADDRESS'] = ray_address
        
        # 获取训练脚本
        train_script = os.environ.get('TRAIN_SCRIPT', './qwen-3b-grpo-1-node.sh')
        print(f"Running training script: {train_script}")
        
        # 执行训练脚本
        if os.path.exists(train_script):
            os.system(f"chmod +x {train_script}")
            result = os.system(f'/bin/bash {train_script}')
            if result != 0:
                print(f"Training script failed with exit code: {result}")
                sys.exit(result)
        else:
            print(f"Training script not found: {train_script}")
            sys.exit(1)
            
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
    
    print("=== Training completed successfully ===")

if __name__ == "__main__":
    main()
