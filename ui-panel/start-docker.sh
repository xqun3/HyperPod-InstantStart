#!/bin/bash

# REMOTE_REPO="public.ecr.aws/t5u4s6i0/hyperpod-instantstart-web:latest"
REMOTE_REPO="public.ecr.aws/t5u4s6i0/hyperpod-instantstart-web25:latest"

LOCAL_IMAGE="ui-panel-dev"


echo "🐳 Starting Model Deployment UI with Docker (Development Mode)..."

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

# 检查本地是否已有镜像
if docker images --format "table {{.Repository}}:{{.Tag}}" | grep -q "^$LOCAL_IMAGE:latest$"; then
    echo "✅ Local image $LOCAL_IMAGE already exists, using it directly"
elif docker images --format "table {{.Repository}}:{{.Tag}}" | grep -q "^$REMOTE_REPO$"; then
    echo "✅ Remote image already exists locally, tagging as $LOCAL_IMAGE"
    docker tag $REMOTE_REPO $LOCAL_IMAGE
else
    echo "📥 Trying to pull from remote repository..."
    if docker pull $REMOTE_REPO; then
        echo "✅ Successfully pulled from remote repository"
        docker tag $REMOTE_REPO $LOCAL_IMAGE
        echo "🏷️ Tagged as $LOCAL_IMAGE"
    else
        echo "🔧 Failed to pull from remote repository, building locally..."
        docker build -f Dockerfile.dev25 -t $LOCAL_IMAGE .
    fi
fi

# 确保本地目录权限
echo "🔧 Setting up permissions..."
mkdir -p ~/.kube ~/.aws logs tmp deployments managed_clusters_info

echo "🚀 Creating and starting new container..."
# --user root
docker run -d \
  --name $LOCAL_IMAGE \
  --network host \
  --user 1000:1000 \
  -v $(pwd)/..:/app/hyperpod-instantstart \
  -v $(pwd)/server:/app/server \
  -v $(pwd)/client/src:/app/client/src \
  -v $(pwd)/client/public:/app/client/public \
  -v $(pwd)/client/user.env:/app/client/user.env \
  -v $(pwd)/client/package.json:/app/client/package.json \
  -v $(pwd)/templates:/app/templates \
  -v $(pwd)/deployments:/app/deployments \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/tmp:/app/tmp \
  -v $(pwd)/mlflow:/app/mlflow \
  -v $(pwd)/managed_clusters_info:/app/managed_clusters_info \
  -v $(pwd)/package.json:/app/package.json \
  -v $(pwd)/nodemon.json:/app/nodemon.json \
  -v /home/ubuntu/workspace/s3:/s3-workspace-metadata \
  -v ~/.kube:/home/node/.kube:rw \
  -v ~/.aws:/home/node/.aws:ro \
  -e NODE_ENV=development \
  -e HOME=/home/node \
  $LOCAL_IMAGE

echo "✅ Container is running!"
echo "📊 Dashboard: http://localhost:3099"
echo "📊 Dashboard: http://$PUBLIC_IP:3099"
echo "🔍 View logs: docker logs -f $LOCAL_IMAGE"
echo "🛑 Stop: docker stop $LOCAL_IMAGE"
