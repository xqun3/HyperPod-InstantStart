import subprocess
import os
import time
import socket
import json

def get_resource_config():
    return dict(current_host = os.environ.get("SM_CURRENT_HOST"),
                hosts = json.loads(os.environ.get("SM_HOSTS")) )
    
def get_master_host():
    master_host = None 
    config = os.environ.get("SM_RESOURCE_CONFIG")
    config = json.loads(config)
    instance_groups = config['instance_groups']
    group_num = len(instance_groups)
    for group in range(group_num):
        group_name = instance_groups[group]['instance_group_name']
        if group_name == 'gpu_group':
            master_host = instance_groups[group]['hosts'][0]   
    return master_host
        

def get_ip_from_host(host):
    ip_wait_time = 200
    counter = 0
    ip = ""
    while counter < ip_wait_time and ip == "":
        try:
            ip = socket.gethostbyname(host)
            break
        except:
            counter += 1
            time.sleep(1)

    if counter == ip_wait_time and ip == "":
        raise Exception(
            "Exceeded max wait time of {}s for hostname resolution".format(ip_wait_time)
        )
    
    return ip

def get_master_host_flag():
    master_host = get_master_host()
    resource_config = get_resource_config()
    current_host = resource_config["current_host"]
    master_ip = get_ip_from_host(master_host)
    current_ip = get_ip_from_host(current_host)
    is_master_host_flag = False
    if current_host == master_host:
        is_master_host_flag = True 
    return current_host, current_ip, is_master_host_flag, master_host, master_ip
        
        
    