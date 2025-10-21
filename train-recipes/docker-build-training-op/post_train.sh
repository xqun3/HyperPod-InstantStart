#!/bin/bash
# Post-train script to set MLflow tags in background
nohup python set_mlflow_tags.py > /tmp/hyperpod/mlflow_tags.log 2>&1 &
exit 0