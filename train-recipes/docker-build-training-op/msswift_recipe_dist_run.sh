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

# Start training
hyperpodrun \
    --nnodes=${NNODES} --nproc-per-node=${NPROC_PER_NODE} \
    --server-host=0.0.0.0 --server-port=8080 \
    --tee=3 --log_dir=/tmp/hyperpod \
    --post-train-script=$LOCAL_WORKDIR/post_train.sh \
    $LMA_RECIPE_LLAMA_FACTORY_LAUNCHER \
        $LMF_RECIPE_YAML_FILE

