---
name: cluster-addons
description: Install and manage cluster add-ons (Karpenter, etc.). Use when user wants to install Karpenter, configure cluster add-ons, or enable additional cluster features.
---

## Karpenter Installation

### When to use
User wants to install HyperPod Karpenter or enable auto-scaling for the cluster.

### Steps

1. Call `karpenter_get_status` to check if already installed
2. If already installed, inform user and show current status
3. If not installed, call `karpenter_install`
4. Inform user: installation is async, takes 2-5 minutes
5. Poll `karpenter_get_status` every **60 seconds** (call `wait_seconds(60)` between polls) until `installed: true`
6. Show final status to user

### Rules
- No user input needed for installation
- Always check status first before installing
- Must poll until installation completes
