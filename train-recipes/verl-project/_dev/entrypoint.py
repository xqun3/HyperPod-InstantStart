import os
import json
import socket
from ray_helper_fn import RayHelper
from get_node_ip import get_master_host_flag
import time
import subprocess

if __name__ == "__main__":
    current_host, current_ip, is_master_host_flag, master_host, master_ip = get_master_host_flag()
    print('--- Launch the Ray Cluster')
    ray_port = "6379"
    ray_helper = RayHelper(ray_port=ray_port)
    ray_helper.start_ray()
    
    if is_master_host_flag == True:
        os.system('ray status')
        train_script = os.environ['TRAIN_SCRIPT']
        print('--- train script', train_script)
        os.system(f"chmod +x {train_script}")
        os.system(f'/bin/bash -c {train_script}')

    else: 
        print('--- This is a worker node, so do nothing')
        pass