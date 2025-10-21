#!/usr/bin/env python3
import yaml
import os
import sys
import json
from datetime import datetime

def load_yaml(file_path):
    """加载YAML文件"""
    try:
        with open(file_path, 'r') as file:
            return yaml.safe_load(file) or {}
    except FileNotFoundError:
        print(f"错误: 文件 {file_path} 不存在")
        sys.exit(1)
    except yaml.YAMLError as e:
        print(f"错误: YAML解析失败 - {e}")
        sys.exit(1)

def save_yaml(data, file_path):
    """保存YAML文件"""
    try:
        with open(file_path, 'w') as file:
            yaml.safe_dump(data, file, default_flow_style=False, indent=2)
    except Exception as e:
        print(f"错误: 保存文件失败 - {e}")
        sys.exit(1)

def main():


    # 获取环境变量
    yaml_file = os.environ.get('LMF_RECIPE_YAML_FILE')
    mlflow_uri = os.environ.get('MLFLOW_TRACKING_URI', '')
    llama_factory_dir = os.environ.get('LMA_RECIPE_LLAMA_FACTORY_DIR', '')
    
    if not yaml_file:
        print("错误: 未设置 LlamaFactory Yaml 配置")
        sys.exit(1)
    
    # 加载YAML数据
    data = load_yaml(yaml_file)
    
    # 处理MLflow配置
    timetag = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    if mlflow_uri and mlflow_uri.strip():
        print("配置MLflow tracking...")
        data['report_to'] = 'mlflow'
        
        # 检查是否存在run_name
        if 'run_name' in data and data['run_name']:
            run_name_value = str(data['run_name'])
            data['run_name'] = f"{run_name_value}_{timetag}"
            print(f"更新run_name: {data['run_name']}")
        else:
            data['run_name'] = f"run_{timetag}"
            print(f"创建run_name: {data['run_name']}")

    else:
        print("清理MLflow配置...")
        data.pop('report_to', None)
        data.pop('run_name', None)
    
    # 处理dataset_dir配置
    dataset_dir = data.get('dataset_dir')
    
    if dataset_dir is None:
        data['dataset_dir'] = f"{llama_factory_dir}/data"
        print(f"dataset_dir设置为: {llama_factory_dir}/data")
    
    # 保存修改后的YAML
    save_yaml(data, yaml_file)
    print("YAML配置处理完成")

    mlflow_lmf_tag_envs = {
        'MLFLOW_RUN': data['run_name'],
        'MODEL': data['model_name_or_path'].split('/')[-1],
        'DATASET': data['dataset'].split('/')[-1],
        'CUTOFF': str(data['cutoff_len']),
        'ZEROCONF': data['deepspeed'].split('/')[-1],
        'MBS': data['per_device_train_batch_size'],
        'ACCUM': data['gradient_accumulation_steps']
    }

    with open('mlflow-tags.json', 'w') as f:
        json.dump(mlflow_lmf_tag_envs, f)

    print("Parsed MLFlow Tags")


if __name__ == "__main__":
    main()
