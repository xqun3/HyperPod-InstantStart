#!/bin/bash
# set -e

echo "Installing dependencies..."
echo "SMHP TRAINING OP NPROC_PER_NODE: ${NPROC_PER_NODE}"
echo "SMHP TRAINING OP NNODES: ${NNODES}"

LOCAL_WORKDIR=/docker_workspace
# export LMA_RECIPE_LLAMA_FACTORY_DIR=$LOCAL_WORKDIR/LLaMA-Factory
# export MSSWIFT_COMMAND_TYPE=swift.cli.sft

cd $LOCAL_WORKDIR
cp -r ${MSSWIFT_RECIPE_RUN_PATH%/}/* ./

# Check if ms-swift directory exists, if not, clone it
if [ ! -d "ms-swift" ]; then
    echo "ms-swift directory not found, cloning from GitHub..."
    git clone https://github.com/modelscope/ms-swift.git
fi

pip install -e ms-swift/

# Parse YAML to command line arguments
MSSWIFT_ARGS=$(python3 -c "
import yaml

with open('$MSSWIFT_RECIPE_YAML_FILE', 'r') as f:
    data = yaml.safe_load(f)

args = []
for key, value in data.items():
    if value is None:
        continue
    if isinstance(value, list):
        args.append(f'--{key}')
        args.extend(str(v) for v in value)
    elif isinstance(value, bool):
        if value:
            args.append(f'--{key}')
    else:
        args.append(f'--{key}')
        args.append(str(value))

print(' '.join(args))
")

echo $MSSWIFT_ARGS

# Start training
hyperpodrun \
    --nnodes=${NNODES} --nproc-per-node=${NPROC_PER_NODE} \
    --server-host=0.0.0.0 --server-port=8080 \
    --tee=3 --log_dir=/tmp/hyperpod \
    --post-train-script=$LOCAL_WORKDIR/post_train.sh \
        -m $MSSWIFT_COMMAND_TYPE \
        $MSSWIFT_ARGS
