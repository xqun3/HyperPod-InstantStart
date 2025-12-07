#!/bin/bash

python3 << 'PYTHON_EOF'
import ray
import subprocess
import os

ray.init(address='auto')

# 获取所有节点
nodes = [n for n in ray.nodes() if n['Alive']]
node_ips = sorted([n['NodeManagerAddress'] for n in nodes])

print(f"Found {len(node_ips)} nodes: {node_ips}")

# 设置环境变量
nproc_per_node = int(os.getenv('INSTRT_PROC_PER_NODE', '4'))
nnodes = len(node_ips)
master_addr = node_ips[0]

# 在每个节点上启动训练进程
@ray.remote(num_gpus=nproc_per_node)
def run_training(node_rank, master_addr, nnodes, nproc_per_node):
    import subprocess
    import os
    
    env = os.environ.copy()
    env.update({
        'NODE_RANK': str(node_rank),
        'MASTER_ADDR': master_addr,
        'NNODES': str(nnodes),
        'NPROC_PER_NODE': str(nproc_per_node),
        'MASTER_PORT': '29500'
    })
    
    print(f"Node {node_rank}: Starting training")
    result = subprocess.run(['bash', '/s3/train-recipes/ray-ddp/launch-train.sh'], env=env, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode

futures = []
for rank, node_ip in enumerate(node_ips):
    future = run_training.options(resources={f"node:{node_ip}": 0.01}).remote(
        rank, master_addr, nnodes, nproc_per_node
    )
    futures.append(future)

# 等待所有节点完成
results = ray.get(futures)
for i, (stdout, stderr, code) in enumerate(results):
    print(f"\n=== Node {i} Output ===")
    print(stdout)
    if stderr:
        print(f"=== Node {i} Errors ===")
        print(stderr)
    print(f"Exit code: {code}")

PYTHON_EOF
