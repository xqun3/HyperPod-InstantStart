#!/bin/bash

set -e

JOB_NAME="verl-training"
NAMESPACE="default"

case "${1:-run}" in
    run)
        echo "🚀 Starting VeRL training..."
        kubectl apply -f verl-training-simple.yaml
        echo "✅ Training job submitted!"
        echo "📊 Check status: ./run_training.sh status"
        echo "📝 View logs: ./run_training.sh logs"
        ;;
    
    status)
        echo "📊 Training job status:"
        kubectl get rayjob $JOB_NAME -n $NAMESPACE -o wide
        echo ""
        echo "📦 Pods:"
        kubectl get pods -l ray.io/cluster=$JOB_NAME -n $NAMESPACE
        ;;
    
    logs)
        echo "📝 Training logs:"
        POD=$(kubectl get pods -l ray.io/cluster=$JOB_NAME,ray.io/node-type=head -n $NAMESPACE -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
        if [ -n "$POD" ]; then
            kubectl logs $POD -n $NAMESPACE -f
        else
            echo "❌ No training pod found"
        fi
        ;;
    
    dashboard)
        echo "🎛️ Opening Ray dashboard..."
        POD=$(kubectl get pods -l ray.io/cluster=$JOB_NAME,ray.io/node-type=head -n $NAMESPACE -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
        if [ -n "$POD" ]; then
            echo "🌐 Dashboard: http://localhost:8265"
            kubectl port-forward $POD 8265:8265 -n $NAMESPACE
        else
            echo "❌ No head pod found"
        fi
        ;;
    
    stop)
        echo "🛑 Stopping training..."
        kubectl delete rayjob $JOB_NAME -n $NAMESPACE --ignore-not-found=true
        echo "✅ Training stopped and cleaned up!"
        ;;
    
    *)
        echo "VeRL Training on KubeRay"
        echo ""
        echo "Usage: $0 [COMMAND]"
        echo ""
        echo "Commands:"
        echo "  run        Start training (default)"
        echo "  status     Check training status"
        echo "  logs       View training logs"
        echo "  dashboard  Open Ray dashboard"
        echo "  stop       Stop and cleanup training"
        ;;
esac
