#!/bin/bash

echo "Installing dependencies..."
echo "SMHP TRAINING OP NPROC_PER_NODE: ${NPROC_PER_NODE}"
echo "SMHP TRAINING OP NNODES: ${NNODES}"

DOCKER_WORKDIR=/docker_workspace

cd $DOCKER_WORKDIR
cp -r ${MSSWIFT_RECIPE_RUN_PATH%/}/* ./
# cp -r /s3/train-recipes/ms-swift-project/* ./

if [ ! -d "ms-swift" ]; then
    echo "ms-swift directory not found, cloning from GitHub..."
    git clone -b v3.11.1 https://github.com/modelscope/ms-swift.git
fi

pip install -e ms-swift/

SERVER_LOG_LEVEL=${SERVER_LOG_LEVEL:-info}
    # --post-train-script=$DOCKER_WORKDIR/post_train.sh \
# sleep 3000
hyperpodrun \
    --nnodes=${NNODES} --nproc-per-node=${NPROC_PER_NODE} \
    --server-host=0.0.0.0 --server-port=8080 \
    --server-log-level=${SERVER_LOG_LEVEL} \
    --tee=3 --log_dir=/tmp/hyperpod \
        -m $MSSWIFT_COMMAND_TYPE \
        --config $MSSWIFT_RECIPE_YAML_FILE
