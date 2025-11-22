
# wget -O eks-hypd-workspace.yaml https://raw.githubusercontent.com/haozhx23/HyperPod-InstantStart/refs/heads/main/cli-min/pre-requisites/eks-hypd-workspace.yaml

name_tag=hypd-workspace-$(date +"%m%d%H%M")
aws cloudformation create-stack \
  --stack-name $name_tag \
  --template-body file://eks-hypd-workspace.yaml \
  --parameters ParameterKey=ResourceTag,ParameterValue=$name_tag \
              ParameterKey=InstanceType,ParameterValue=m5.2xlarge \
              ParameterKey=EBSVolumeSize,ParameterValue=200 \
              ParameterKey=KeyPairName,ParameterValue=pdxkeypair \
  --capabilities CAPABILITY_NAMED_IAM

# ParameterKey=ExistingS3BucketName,ParameterValue=$EXISTING_S3_BUCKET \
