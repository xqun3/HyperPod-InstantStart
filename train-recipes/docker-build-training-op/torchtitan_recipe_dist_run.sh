#!/bin/bash
# set -e

echo "Installing dependencies..."
echo "SMHP TRAINING OP NPROC_PER_NODE: ${NPROC_PER_NODE}"
echo "SMHP TRAINING OP NNODES: ${NNODES}"

LOCAL_WORKDIR=/docker_workspace

cd $LOCAL_WORKDIR

# TORCH_RECIPE_DIRPATH=${TORCH_RECIPE_PY_PATH%/*}
# PY_NAME=$(basename "$TORCH_RECIPE_PY_PATH")
# cp -r $TORCH_RECIPE_DIRPATH/* ./

cp -r /torchtitan/* ./

source .venv/bin/activate

python3 scripts/download_hf_assets.py --repo_id Qwen/Qwen3-32B --assets tokenizer

CONFIG_FILE="./torchtitan/models/qwen3/train_configs/qwen3_1.7b.toml"
TRAIN_FILE=${TRAIN_FILE:-"torchtitan.train"}
LOG_RANK=${LOG_RANK:-0}

# CONFIG_FILE="./torchtitan/models/qwen3/train_configs/qwen3_1.7b.toml" \
#     ./run_train.sh \
#     --metrics.log_freq=1 \
#     --training.steps=50 \
#     --training.local_batch_size=1 \
#     --parallelism.tensor_parallel_degree=1 \
#     --model.name="qwen3" \
#     --model.flavor="32B" \
#     --model.hf_assets_path="./assets/hf/Qwen3-32B"


NGPU=${NGPU:-"8"}
export LOG_RANK=${LOG_RANK:-0}
CONFIG_FILE=${CONFIG_FILE:-"./torchtitan/models/llama3/train_configs/debug_model.toml"}
TRAIN_FILE=${TRAIN_FILE:-"torchtitan.train"}

TORCHFT_LIGHTHOUSE=${TORCHFT_LIGHTHOUSE:-"http://localhost:29510"}

PYTORCH_ALLOC_CONF="expandable_segments:True" \
TORCHFT_LIGHTHOUSE=${TORCHFT_LIGHTHOUSE} \
torchrun --nproc_per_node=${NGPU} --rdzv_backend c10d --rdzv_endpoint="localhost:0" \
--local-ranks-filter ${LOG_RANK} --role rank --tee 3 \
-m ${TRAIN_FILE} --job.config_file ${CONFIG_FILE} "$@"




CMD="hyperpodrun \
    --nnodes=${NNODES} --nproc-per-node=${NPROC_PER_NODE} \
    --server-host=0.0.0.0 --server-port=8080 \
    --tee=3 --log_dir=/tmp/hyperpod \
    ${TRAIN_FILE} \
        --job.config_file ${CONFIG_FILE} "$@"


echo "Executing hyperpodrun command:"
echo "$CMD"

eval "$CMD"

