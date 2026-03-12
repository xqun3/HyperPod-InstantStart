import os
import sys
import uuid

def main():

    hosts = eval(os.environ['SM_HOSTS'])
    current_host = os.environ['SM_CURRENT_HOST']
    num_nodes = int(os.environ['N_NODES'])
    num_gpus = int(os.environ['NPROC_PER_NODE'])
    rank = hosts.index(current_host)
    base_job = os.environ['BASE_JOB_NAME']
    base_path = os.environ['SM_PATH']
    
    # job_uuid = str(uuid.uuid4())[-4:]
    # job_name = f"{base_job}-{job_uuid}"
    
    hyp_params = os.environ['HYP_PARAMS']
    hostaddr = hosts[0]
    
    # print("=== Distributed Training Setup ===")
    # print(f"MASTER_ADDR: {master_addr}")
    # print(f"MASTER_PORT: {master_port}")
    # print(f"WORLD_SIZE: {world_size}")
    # print(f"CURRENT_HOST: {current_host}")
    # print(f"ALL_HOSTS: {hosts}")
    # print("===================================")
    
    # 构建torchrun命令，使用带UUID的job_name
    # args = " ".join(sys.argv[1:])
    cmd = f"torchrun --nnodes={num_nodes} --nproc_per_node={num_gpus} --rdzv_id={base_job} --rdzv_backend=c10d --rdzv_endpoint={hostaddr}:7777 {base_path}/codes/train_ddp.py {hyp_params}"
    print(f"Executing: {cmd}")
    
    # 执行torchrun
    exit_code = os.system(cmd)
    sys.exit(exit_code >> 8)  # os.system返回的是shifted exit code

if __name__ == '__main__':
    main()
