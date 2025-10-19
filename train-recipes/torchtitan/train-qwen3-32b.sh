#/bin/bash
# example docker run command:
# docker run -it --rm --gpus all -v `pwd`/train-qwen3-32b.sh:/torchtitan/train.sh 236995464743.dkr.ecr.us-east-2.amazonaws.com/torchtitan:latest /torchtitan/train.sh

source /torchtitan/.venv/bin/activate

cd /torchtitan

python3 scripts/download_hf_assets.py --repo_id Qwen/Qwen3-32B --assets tokenizer

CONFIG_FILE="./torchtitan/models/llama3/train_configs/llama3_70b.toml" \
    ./run_train.sh \
    --metrics.log_freq=1 \
    --training.steps=50 \
    --training.local_batch_size=1 \
    --parallelism.tensor_parallel_degree=1 \
    --model.name="qwen3" \
    --model.flavor="32B" \
    --model.hf_assets_path="./assets/hf/Qwen3-32B"

