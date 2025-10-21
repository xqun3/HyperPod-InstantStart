#!/bin/bash
# set -e

echo "Installing dependencies..."
echo "SMHP TRAINING OP NPROC_PER_NODE: ${NPROC_PER_NODE}"
echo "SMHP TRAINING OP NNODES: ${NNODES}"

LOCAL_WORKDIR=/docker_workspace
export LMA_RECIPE_LLAMA_FACTORY_DIR=$LOCAL_WORKDIR/LLaMA-Factory
LMA_RECIPE_LLAMA_FACTORY_LAUNCHER=$LMA_RECIPE_LLAMA_FACTORY_DIR/src/llamafactory/launcher.py

cd $LOCAL_WORKDIR
cp -r ${LMF_RECIPE_RUN_PATH%/}/* ./

echo "处理 LlamaFactory Yaml 适配"

python lmf_process_train_yaml.py

echo "完成 LlamaFactory Yaml 适配"

# runtag=$(date '+%Y%m%d_%H%M%S')
# export MLFLOW_RUN_NAME="run-$runtag"

# envsubst < $LMF_RECIPE_YAML_FILE > current_lmf_conf.yaml

# # Generate post-train script
# echo "Generating post-train script..."
# cat > post_train.sh << 'EOF'
# #!/bin/bash
# # Post-train script to set MLflow tags in background
# nohup python set_mlflow_tags.py > /tmp/hyperpod/mlflow_tags.log 2>&1 &
# exit 0
# EOF
# chmod +x post_train.sh

# Start training
hyperpodrun \
    --nnodes=${NNODES} --nproc-per-node=${NPROC_PER_NODE} \
    --server-host=0.0.0.0 --server-port=8080 \
    --tee=3 --log_dir=/tmp/hyperpod \
    --post-train-script=$LOCAL_WORKDIR/post_train.sh \
    $LMA_RECIPE_LLAMA_FACTORY_LAUNCHER \
        $LMF_RECIPE_YAML_FILE

