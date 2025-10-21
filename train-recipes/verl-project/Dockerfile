FROM 763104351884.dkr.ecr.us-west-2.amazonaws.com/pytorch-training:2.6.0-gpu-py312-cu126-ubuntu22.04-ec2

COPY src /verl_workspace
WORKDIR /verl_workspace

RUN python -m pip install --upgrade pip
RUN pip install -e ./verl
RUN pip install vllm==0.8.4
RUN pip install sglang==0.4.6.post5
RUN pip install wandb 
RUN pip install boto3
RUN pip install --upgrade huggingface_hub
RUN pip install hf_xet
