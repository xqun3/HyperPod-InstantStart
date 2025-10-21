import subprocess
import os
import time
import ray
import socket
import json
import sys

class RayHelper():
    def __init__(self, ray_port:str="6379", redis_pass:str="redis_password"):
        self.ray_port = ray_port
        self.redis_pass = redis_pass
        self.resource_config = self.get_resource_config()
        self.master_host = self.get_gpu_host()
        self.n_hosts = len(self.resource_config["hosts"])
        
    @staticmethod
    def get_gpu_host():
        master_host = None 
        config = os.environ.get("SM_RESOURCE_CONFIG")
        config = json.loads(config)
        instance_groups = config['instance_groups']
        group_num = len(instance_groups)
        for group in range(group_num):
            group_name = instance_groups[group]['instance_group_name']
            if group_name == 'gpu_group':
                # take the first host as the master host
                # print('--- instance_groups[group][hosts]', instance_groups[group]['hosts'])
                master_host = instance_groups[group]['hosts'][0]   
                # print('--- master host', master_host)
        return master_host
        
        
    @staticmethod
    def get_resource_config():
        return dict(current_host = os.environ.get("SM_CURRENT_HOST"),
                    hosts = json.loads(os.environ.get("SM_HOSTS")) )
    
    def _get_head_port(self):
        return self.ray_port
    
    def _get_master_ip_from_host(self):
        ip_wait_time = 200
        counter = 0
        ip = ""

        while counter < ip_wait_time and ip == "":
            try:
                ip = socket.gethostbyname(self.master_host)
                break
            except:
                counter += 1
                time.sleep(1)

        if counter == ip_wait_time and ip == "":
            raise Exception(
                "Exceeded max wait time of {}s for hostname resolution".format(ip_wait_time)
            )

        return ip
    
    def start_ray(self):
        self.master_ip = self._get_master_ip_from_host()
        print('--- self.master_ip', self.master_ip)
        if self.resource_config["current_host"] == self.master_host:
            if ray.is_initialized():
                print("There is a Ray cluste already running. Shutting it down.")
                ray.shutdown()
                time.sleep(5)
                
            print('--- ...start the head node')
            output = subprocess.run(['ray', 'start', '--head',  '--port', self.ray_port, '--redis-password', self.redis_pass, '--dashboard-host', '0.0.0.0', '--dashboard-port', '8265'], stdout=subprocess.PIPE)
            time.sleep(120) # wait all worker nodes to join the cluster
           
        else:
            time.sleep(20) # wait for the master node be ready
            print('--- ...add worker node')
            output = subprocess.run(['ray', 'start', f'--address={self.master_ip}:{self.ray_port}', '--redis-password', self.redis_pass, '--block'], stdout=subprocess.PIPE)
            sys.exit(0)  
            
    
    def _wait_for_workers(self, timeout=120):
        print(f"Waiting {timeout} seconds for {self.n_hosts} nodes to join")
        while len(ray.nodes()) < self.n_hosts:
            print(f"{len(ray.nodes())} nodes connected to cluster")
            time.sleep(5)
            timeout-=5
            if timeout==0:
                raise Exception("Max timeout for nodes to join exceeded")
        time.sleep(5)
        print(f"{len(ray.nodes())} nodes connected to cluster")

        