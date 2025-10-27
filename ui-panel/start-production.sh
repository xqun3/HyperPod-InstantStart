#!/bin/bash

# HyperPod InstantStart - Production Docker Startup
# 简化版启动脚本，供同事使用

REMOTE_REPO="public.ecr.aws/t5u4s6i0/hyperpod-instantstart-web25:latest"
LOCAL_IMAGE="ui-panel-production"

echo "🚀 Starting HyperPod InstantStart (Production Mode)..."

# 检查 Docker 是否安装
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# 获取公网 IP
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null)
PUBLIC_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null)

# 清理可能存在的旧容器
docker stop $LOCAL_IMAGE 2>/dev/null || true
docker rm $LOCAL_IMAGE 2>/dev/null || true

echo "📥 Pulling latest image from remote repository..."
if docker pull $REMOTE_REPO; then
    echo "✅ Successfully pulled from remote repository"
    docker tag $REMOTE_REPO $LOCAL_IMAGE
else
    echo "❌ Failed to pull from remote repository. Please check your network connection."
    exit 1
fi

# 确保必要的目录存在
echo "🔧 Setting up directories..."
mkdir -p ~/.kube ~/.aws

echo "🚀 Starting container..."
docker run -d \
  --name $LOCAL_IMAGE \
  --network host \
  --user 1000:1000 \
  -v ~/.kube:/home/node/.kube:rw \
  -v ~/.aws:/home/node/.aws:ro \
  -v /home/ubuntu/workspace/s3:/s3-workspace-metadata \
  -e NODE_ENV=production \
  -e HOME=/home/node \
  $LOCAL_IMAGE

echo "✅ Container is running!"
echo "📊 Dashboard: http://localhost:3099"
if [ ! -z "$PUBLIC_IP" ]; then
    echo "📊 Dashboard: http://$PUBLIC_IP:3099"
fi
echo "🔍 View logs: docker logs -f $LOCAL_IMAGE"
echo "🛑 Stop: docker stop $LOCAL_IMAGE"