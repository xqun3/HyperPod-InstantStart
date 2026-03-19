const { execSync } = require('child_process');

/**
 * Compute Subnet Manager
 * 管理 EKS Node Group 使用的 compute subnet
 * 命名规则: hp-compute-{az} (如 hp-compute-us-east-2a)
 */
class ComputeSubnetManager {

  static SUBNET_PREFIX = 'hp-compute';

  /**
   * 确保指定 AZ 存在 compute subnet，不存在则创建
   * @param {string} vpcId - VPC ID
   * @param {string} availabilityZone - 可用区名称 (如 us-east-2a)
   * @param {string} region - AWS 区域
   * @param {string} clusterName - EKS 集群名称 (用于 karpenter discovery tag)
   * @returns {Promise<{subnetId: string, created: boolean}>}
   */
  static async ensureComputeSubnet(vpcId, availabilityZone, region, clusterName) {
    console.log(`[ComputeSubnetManager] Ensuring compute subnet in AZ: ${availabilityZone}`);

    // 1. 检查是否已存在
    const existingSubnet = await this.findComputeSubnet(vpcId, availabilityZone, region);
    if (existingSubnet) {
      console.log(`[ComputeSubnetManager] Found existing compute subnet: ${existingSubnet.subnetId}`);
      return { subnetId: existingSubnet.subnetId, created: false };
    }

    // 2. 不存在则创建
    console.log(`[ComputeSubnetManager] No compute subnet found, creating new one...`);
    const newSubnet = await this.createComputeSubnet(vpcId, availabilityZone, region, clusterName);
    return { subnetId: newSubnet.subnetId, created: true };
  }

  /**
   * 查找指定 AZ 的 compute subnet
   */
  static async findComputeSubnet(vpcId, availabilityZone, region) {
    try {
      const subnetName = `${this.SUBNET_PREFIX}-${availabilityZone}`;
      const cmd = `aws ec2 describe-subnets --region ${region} \
        --filters "Name=vpc-id,Values=${vpcId}" "Name=tag:Name,Values=${subnetName}" \
        --query "Subnets[0].{SubnetId:SubnetId,CidrBlock:CidrBlock}" --output json`;

      const result = JSON.parse(execSync(cmd, { encoding: 'utf8' }));
      if (result && result.SubnetId) {
        return { subnetId: result.SubnetId, cidrBlock: result.CidrBlock };
      }
      return null;
    } catch (error) {
      console.log(`[ComputeSubnetManager] No existing compute subnet found: ${error.message}`);
      return null;
    }
  }

  /**
   * 创建 compute subnet
   */
  static async createComputeSubnet(vpcId, availabilityZone, region, clusterName) {
    // 1. 获取可用的 CIDR
    const cidr = await this.getAvailableCidr(vpcId, region);
    console.log(`[ComputeSubnetManager] Using CIDR: ${cidr}`);

    // 2. 获取 AZ ID
    const azId = await this.getAzId(availabilityZone, region);

    // 3. 获取 NAT Gateway
    const natGwId = await this.getNatGateway(vpcId, region);

    // 4. 创建子网
    const subnetName = `${this.SUBNET_PREFIX}-${availabilityZone}`;
    const createSubnetCmd = `aws ec2 create-subnet --region ${region} \
      --vpc-id ${vpcId} \
      --cidr-block ${cidr} \
      --availability-zone-id ${azId} \
      --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=${subnetName}},{Key=karpenter.sh/discovery,Value=${clusterName}}]' \
      --query 'Subnet.SubnetId' --output text`;

    const subnetId = execSync(createSubnetCmd, { encoding: 'utf8' }).trim();
    console.log(`[ComputeSubnetManager] Created subnet: ${subnetId}`);

    // 5. 创建路由表
    const rtName = `${subnetName}-rt`;
    const createRtCmd = `aws ec2 create-route-table --region ${region} \
      --vpc-id ${vpcId} \
      --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=${rtName}}]' \
      --query 'RouteTable.RouteTableId' --output text`;

    const routeTableId = execSync(createRtCmd, { encoding: 'utf8' }).trim();
    console.log(`[ComputeSubnetManager] Created route table: ${routeTableId}`);

    // 6. 关联路由表到子网
    execSync(`aws ec2 associate-route-table --region ${region} \
      --route-table-id ${routeTableId} --subnet-id ${subnetId}`, { encoding: 'utf8' });

    // 7. 添加默认路由到 NAT Gateway
    execSync(`aws ec2 create-route --region ${region} \
      --route-table-id ${routeTableId} \
      --destination-cidr-block 0.0.0.0/0 \
      --nat-gateway-id ${natGwId}`, { encoding: 'utf8' });
    console.log(`[ComputeSubnetManager] Added NAT Gateway route`);

    // 8. 配置 S3 VPC Endpoint
    await this.configureS3Endpoint(vpcId, routeTableId, region);

    return { subnetId, cidrBlock: cidr, routeTableId };
  }

  /**
   * 获取可用的 CIDR (/20)
   */
  static async getAvailableCidr(vpcId, region) {
    // 获取 VPC CIDR
    const vpcCmd = `aws ec2 describe-vpcs --region ${region} --vpc-ids ${vpcId} \
      --query "Vpcs[0].CidrBlockAssociationSet[?CidrBlockState.State=='associated'].CidrBlock" --output text`;
    const vpcCidrs = execSync(vpcCmd, { encoding: 'utf8' }).trim().split(/\s+/);

    // 获取已存在的子网 CIDR
    const subnetCmd = `aws ec2 describe-subnets --region ${region} \
      --filters "Name=vpc-id,Values=${vpcId}" \
      --query "Subnets[*].CidrBlock" --output text`;
    const existingCidrs = execSync(subnetCmd, { encoding: 'utf8' }).trim().split(/\s+/).filter(c => c);

    // 使用最大的 VPC CIDR（prefix 最小 = 地址空间最大）
    const TARGET_PREFIX = 20;
    const subnetSize = Math.pow(2, 32 - TARGET_PREFIX);

    const sorted = vpcCidrs
      .map(c => { const [ip, p] = c.split('/'); return { cidr: c, base: this.ipToInt(ip), prefix: parseInt(p) }; })
      .filter(v => v.prefix <= TARGET_PREFIX)
      .sort((a, b) => a.prefix - b.prefix);

    if (sorted.length === 0) {
      throw new Error(`No VPC CIDR large enough to fit a /${TARGET_PREFIX} subnet (available: ${vpcCidrs.join(', ')})`);
    }

    for (const vpc of sorted) {
      const vpcSize = Math.pow(2, 32 - vpc.prefix);
      const totalSlots = vpcSize / subnetSize;
      // 从第二个 /20 块开始，保留第一个给其他用途
      for (let i = 1; i < totalSlots; i++) {
        const subnetStart = vpc.base + i * subnetSize;
        const subnetCidr = `${this.intToIp(subnetStart)}/${TARGET_PREFIX}`;
        if (!this.cidrOverlaps(subnetCidr, existingCidrs)) {
          return subnetCidr;
        }
      }
    }

    throw new Error('No available /20 CIDR block found in VPC');
  }

  /**
   * 获取 AZ ID
   */
  static async getAzId(availabilityZone, region) {
    const cmd = `aws ec2 describe-availability-zones --region ${region} \
      --query "AvailabilityZones[?ZoneName=='${availabilityZone}'].ZoneId" --output text`;
    const azId = execSync(cmd, { encoding: 'utf8' }).trim();
    if (!azId) {
      throw new Error(`Invalid availability zone: ${availabilityZone}`);
    }
    return azId;
  }

  /**
   * 获取 NAT Gateway
   */
  static async getNatGateway(vpcId, region) {
    const cmd = `aws ec2 describe-nat-gateways --region ${region} \
      --filter "Name=vpc-id,Values=${vpcId}" "Name=state,Values=available" \
      --query "NatGateways[0].NatGatewayId" --output text`;
    const natGwId = execSync(cmd, { encoding: 'utf8' }).trim();
    if (!natGwId || natGwId === 'None') {
      throw new Error(`No available NAT Gateway found in VPC: ${vpcId}`);
    }
    return natGwId;
  }

  /**
   * 配置 S3 VPC Endpoint
   */
  static async configureS3Endpoint(vpcId, routeTableId, region) {
    try {
      // 检查是否已存在
      const checkCmd = `aws ec2 describe-vpc-endpoints --region ${region} \
        --filters "Name=vpc-id,Values=${vpcId}" "Name=service-name,Values=com.amazonaws.${region}.s3" \
        --query "VpcEndpoints[0].VpcEndpointId" --output text`;
      const existingEndpoint = execSync(checkCmd, { encoding: 'utf8' }).trim();

      if (existingEndpoint && existingEndpoint !== 'None') {
        // 添加路由表到现有 endpoint
        execSync(`aws ec2 modify-vpc-endpoint --region ${region} \
          --vpc-endpoint-id ${existingEndpoint} \
          --add-route-table-ids ${routeTableId}`, { encoding: 'utf8', stdio: 'pipe' });
        console.log(`[ComputeSubnetManager] Added route table to existing S3 endpoint`);
      } else {
        // 创建新的 endpoint
        execSync(`aws ec2 create-vpc-endpoint --region ${region} \
          --vpc-id ${vpcId} \
          --service-name com.amazonaws.${region}.s3 \
          --route-table-ids ${routeTableId}`, { encoding: 'utf8' });
        console.log(`[ComputeSubnetManager] Created new S3 VPC endpoint`);
      }
    } catch (error) {
      console.log(`[ComputeSubnetManager] S3 endpoint config warning: ${error.message}`);
    }
  }

  // Helper: IP to integer (unsigned)
  static ipToInt(ip) {
    const parts = ip.split('.').map(Number);
    return ((parts[0] * 16777216) + (parts[1] * 65536) + (parts[2] * 256) + parts[3]) >>> 0;
  }

  // Helper: Integer to IP
  static intToIp(int) {
    return `${(int >>> 24) & 255}.${(int >>> 16) & 255}.${(int >>> 8) & 255}.${int & 255}`;
  }

  // Helper: Check CIDR overlap
  static cidrOverlaps(newCidr, existingCidrs) {
    const [newIp, newPrefix] = newCidr.split('/');
    const newStart = this.ipToInt(newIp);
    const newSize = Math.pow(2, 32 - parseInt(newPrefix));
    const newEnd = newStart + newSize - 1;

    for (const existing of existingCidrs) {
      const [existIp, existPrefix] = existing.split('/');
      const existStart = this.ipToInt(existIp);
      const existSize = Math.pow(2, 32 - parseInt(existPrefix));
      const existEnd = existStart + existSize - 1;

      if (newStart <= existEnd && newEnd >= existStart) {
        return true;
      }
    }
    return false;
  }
}

module.exports = ComputeSubnetManager;
