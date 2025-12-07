echo "MasterAddr:${MASTER_ADDR}"
echo "NodeRank:${NODE_RANK}"
# echo "NumNode:${NNODES}"
# echo "NumProcsPerNode:${PROC_PER_NODE}"


# openai-community/gpt2
# openai-community/gpt2-medium
# facebook/opt-350m
# bigscience/bloom-1b1
# EleutherAI/pythia-1.4b
torchrun \
    --nnodes=${NNODES} \
    --nproc_per_node=${NPROC_PER_NODE} \
    --node_rank=${NODE_RANK} \
    --master_addr=${MASTER_ADDR} \
    --master_port=${MASTER_PORT} \
    /s3/train-recipes/torch-project-gpt-ddp/trainer_gpt_ddp.py \
    --model_name_or_path gpt2 \
    --dataset_name wikitext \
    --dataset_config_name wikitext-2-raw-v1 \
    --output_dir /ckpt-path \
    --num_train_epochs 1 \
    --per_device_train_batch_size 4 \
    --gradient_accumulation_steps 2 \
    --max_steps 100 \
    --max_context_width 2048 \
    --learning_rate 5e-5 \
    --save_steps 100    