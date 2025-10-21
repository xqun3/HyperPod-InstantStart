#!/bin/bash
# set -e

echo "Installing dependencies..."
echo "SMHP TRAINING OP NPROC_PER_NODE: ${NPROC_PER_NODE}"
echo "SMHP TRAINING OP NNODES: ${NNODES}"

LOCAL_WORKDIR=/docker_workspace

cd $LOCAL_WORKDIR

TORCH_RECIPE_DIRPATH=${TORCH_RECIPE_PY_PATH%/*}
PY_NAME=$(basename "$TORCH_RECIPE_PY_PATH")
cp -r $TORCH_RECIPE_DIRPATH/* ./

echo "处理 MLFlow tags"
TORCH_RECIPE_PY_PARAMS=$(echo "$TORCH_RECIPE_PY_PARAMS" | sed "s/--run_name \([^ ]*\)/--run_name \1_$(date +"%m%d_%H%M%S")/")
python torch_process_train_args.py "$TORCH_RECIPE_PY_PARAMS"

[ -f "requirements.txt" ] && pip install -r requirements.txt

CMD="hyperpodrun \
    --nnodes=${NNODES} --nproc-per-node=${NPROC_PER_NODE} \
    --server-host=0.0.0.0 --server-port=8080 \
    --tee=3 --log_dir=/tmp/hyperpod \
    --post-train-script=$LOCAL_WORKDIR/post_train.sh \
    $LOCAL_WORKDIR/$PY_NAME \
        $TORCH_RECIPE_PY_PARAMS"

# 打印命令
echo "Executing hyperpodrun command:"
echo "$CMD"

eval "$CMD"
