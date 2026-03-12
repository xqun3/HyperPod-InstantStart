#!/bin/bash

if [ $# -eq 1 ]; then
    JOB_NAME="$1"
    echo "📋 Using specified job: $JOB_NAME"
else
    JOB_NAME=$(kubectl get trainingjob --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].spec.trainingJobName}')
    echo "📋 Latest job: $JOB_NAME"
fi

if [ -z "$JOB_NAME" ]; then
    echo "❌ No job name found"
    exit 1
fi

LOG_STREAMS=$(aws logs describe-log-streams --log-group-name /aws/sagemaker/TrainingJobs --log-stream-name-prefix $JOB_NAME --query 'logStreams[*].logStreamName' --output text)

if [ -z "$LOG_STREAMS" ]; then
    echo "⏳ No logs available yet for job: $JOB_NAME"
    exit 1
fi

# Convert space-separated streams to comma-separated for AWS CLI
STREAM_NAMES=$(echo $LOG_STREAMS | tr ' ' ',')
STREAM_COUNT=$(echo $LOG_STREAMS | wc -w)

echo "📄 Found $STREAM_COUNT log streams for job: $JOB_NAME"
for stream in $LOG_STREAMS; do
    echo "  - $stream"
done
echo "----------------------------------------"

# Follow all log streams
aws logs tail /aws/sagemaker/TrainingJobs --log-stream-names "$STREAM_NAMES" --follow