#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="verl-training-cluster"
JOB_NAME="verl-training-job"
NAMESPACE="default"

function print_usage() {
    echo "Usage: $0 [COMMAND]"
    echo "Commands:"
    echo "  deploy-cluster    - Deploy Ray cluster only"
    echo "  deploy-job        - Deploy Ray job (includes cluster)"
    echo "  status           - Check cluster/job status"
    echo "  logs             - Get job logs"
    echo "  cleanup          - Clean up resources"
    echo "  dashboard        - Port forward to Ray dashboard"
}

function deploy_cluster() {
    echo "Deploying Ray cluster..."
    kubectl apply -f "${SCRIPT_DIR}/kuberay-cluster.yaml"
    
    echo "Waiting for cluster to be ready..."
    kubectl wait --for=condition=Ready raycluster/${CLUSTER_NAME} --timeout=300s -n ${NAMESPACE}
    
    echo "Ray cluster deployed successfully!"
    kubectl get raycluster ${CLUSTER_NAME} -n ${NAMESPACE}
}

function deploy_job() {
    echo "Deploying Ray job..."
    kubectl apply -f "${SCRIPT_DIR}/verl-training-job.yaml"
    
    echo "Ray job submitted successfully!"
    kubectl get rayjob ${JOB_NAME} -n ${NAMESPACE}
}

function check_status() {
    echo "=== Ray Cluster Status ==="
    kubectl get raycluster ${CLUSTER_NAME} -n ${NAMESPACE} -o wide 2>/dev/null || echo "No cluster found"
    
    echo ""
    echo "=== Ray Job Status ==="
    kubectl get rayjob ${JOB_NAME} -n ${NAMESPACE} -o wide 2>/dev/null || echo "No job found"
    
    echo ""
    echo "=== Pods Status ==="
    kubectl get pods -l ray.io/cluster=${CLUSTER_NAME} -n ${NAMESPACE}
}

function get_logs() {
    echo "Getting Ray job logs..."
    
    # 获取job pod
    JOB_POD=$(kubectl get pods -l ray.io/cluster=${CLUSTER_NAME},ray.io/node-type=head -n ${NAMESPACE} -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [ -n "$JOB_POD" ]; then
        echo "Logs from pod: $JOB_POD"
        kubectl logs $JOB_POD -n ${NAMESPACE} -f
    else
        echo "No job pod found"
    fi
}

function cleanup() {
    echo "Cleaning up resources..."
    
    kubectl delete rayjob ${JOB_NAME} -n ${NAMESPACE} --ignore-not-found=true
    kubectl delete raycluster ${CLUSTER_NAME} -n ${NAMESPACE} --ignore-not-found=true
    
    echo "Cleanup completed!"
}

function port_forward_dashboard() {
    echo "Port forwarding Ray dashboard..."
    
    HEAD_POD=$(kubectl get pods -l ray.io/cluster=${CLUSTER_NAME},ray.io/node-type=head -n ${NAMESPACE} -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [ -n "$HEAD_POD" ]; then
        echo "Dashboard will be available at: http://localhost:8265"
        kubectl port-forward $HEAD_POD 8265:8265 -n ${NAMESPACE}
    else
        echo "No head pod found"
    fi
}

case "${1:-}" in
    deploy-cluster)
        deploy_cluster
        ;;
    deploy-job)
        deploy_job
        ;;
    status)
        check_status
        ;;
    logs)
        get_logs
        ;;
    cleanup)
        cleanup
        ;;
    dashboard)
        port_forward_dashboard
        ;;
    *)
        print_usage
        exit 1
        ;;
esac
