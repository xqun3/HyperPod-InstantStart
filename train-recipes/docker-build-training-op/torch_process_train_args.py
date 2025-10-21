#!/usr/bin/env python3
import json
import shlex
import re
import sys
import argparse

def parse_args_string(args_string):
    config = {}
    clean_string = re.sub(r'\\\s*\n\s*', ' ', args_string.strip())
    
    try:
        args_list = shlex.split(clean_string)
    except ValueError as e:
        print(f"字符串解析错误: {e}")
        return None
    
    i = 0
    while i < len(args_list):
        if args_list[i].startswith('--'):
            key = args_list[i][2:]  # 移除 '--'
            
            # 检查下一个元素是否是值
            if i + 1 < len(args_list) and not args_list[i + 1].startswith('--'):
                value = args_list[i + 1]
                
                # 尝试转换数据类型
                if value.replace('.', '').replace('-', '').replace('e', '').replace('+', '').isdigit():
                    if '.' in value or 'e' in value.lower():
                        config[key] = float(value)
                    else:
                        config[key] = int(value)
                else:
                    config[key] = value
                i += 2
            else:
                # 布尔标志
                config[key] = True
                i += 1
        else:
            i += 1
    
    return config

def save_to_json(config, filename='config.json'):
    """保存配置到JSON文件"""
    metric_tags = {
        "MLFLOW_RUN": config['run_name'],
        "MODEL": config['model_type'] if 'model_name_or_path' not in config else config['model_name_or_path'],
        "DATASET": config['dataset_name'],
        "CUTOFF": config['max_context_width'],
        "ZEROCONF": 'DDP' if 'deepspeed' not in config else config['deepspeed'],
        "MBS": config['per_device_train_batch_size'],
        "ACCUM": config['gradient_accumulation_steps']
    }
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(metric_tags, f, indent=2, ensure_ascii=False)
    print(f"配置已保存到: {filename}")

def main():
    parser = argparse.ArgumentParser(description='解析参数字符串并转换为JSON')
    parser.add_argument('args_string', help='要解析的参数字符串')
    parser.add_argument('-o', '--output', default='mlflow-tags.json')
    
    args = parser.parse_args()
    
    # 解析参数字符串
    config = parse_args_string(args.args_string)
    
    if config is None:
        sys.exit(1)
    
    # 打印解析结果
    print(json.dumps(config, indent=2, ensure_ascii=False))
    
    save_to_json(config, args.output)
    
    return config

if __name__ == "__main__":
    main()
