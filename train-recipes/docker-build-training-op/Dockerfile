# FROM 763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-training:2.7.1-gpu-py312-cu128-ubuntu22.04-ec2
FROM 763104351884.dkr.ecr.us-west-2.amazonaws.com/pytorch-inference:2.6.0-gpu-py312-cu124-ubuntu22.04-ec2

# ENV DEBIAN_FRONTEND=noninteractive
# ENV PYTHONUNBUFFERED=TRUE
# ENV PYTHONDONTWRITEBYTECODE=TRUE

WORKDIR /docker_workspace

# RUN pip install transformers datasets
RUN pip install -U pip

RUN pip install hyperpod-elastic-agent

RUN pip install deepspeed==0.16.4
# vllm==0.8.2 bitsandbytes == 0.43.1


RUN git clone --depth 1 -b v0.9.3 https://github.com/hiyouga/LLaMA-Factory.git
RUN cd LLaMA-Factory && pip install -e ".[torch,metrics]" --no-build-isolation

RUN pip install flash-attn==2.7.2.post1

# pip uninstall -y ninja && pip install ninja

RUN pip install mlflow==3.0.0 sagemaker-mlflow==0.1.0
# mlflow==2.13.2

# RUN apt-get update && apt-get install gettext-base
RUN apt-get update && apt-get install -y gettext-base && rm -rf /var/lib/apt/lists/*

RUN pip install PyYAML

COPY lmf_process_train_yaml.py ./lmf_process_train_yaml.py
COPY lmf_recipe_dist_run.sh ./lmf_recipe_dist_run.sh
COPY torch_process_train_args.py ./torch_process_train_args.py
COPY torch_recipe_dist_run.sh ./torch_recipe_dist_run.sh
COPY script_recipe_dist_run.sh ./script_recipe_dist_run.sh
COPY set_mlflow_tags.py ./set_mlflow_tags.py
COPY post_train.sh ./post_train.sh

RUN chmod +x *.sh