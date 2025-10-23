const { execSync } = require('child_process');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

class AWSHelpers {
  
  /**
   * 获取HyperPod集群的详细信息
   * @param {string} clusterName - HyperPod集群名称
   * @param {string} region - AWS区域
   * @returns {Promise<Object>} HyperPod集群详细信息
   */
  static async describeHyperPodCluster(clusterName, region) {
    try {
      const command = `aws sagemaker describe-cluster --cluster-name ${clusterName} --region ${region} --output json`;
      const result = await exec(command);
      return JSON.parse(result.stdout);
    } catch (error) {
      console.error(`Error describing HyperPod cluster ${clusterName}:`, error);
      throw error;
    }
  }

  /**
   * 获取当前AWS账户ID
   * @returns {string} AWS账户ID
   */
  static getCurrentAccountId() {
    try {
      const command = 'aws sts get-caller-identity --query Account --output text';
      return execSync(command, { encoding: 'utf8' }).trim();
    } catch (error) {
      console.error('Error getting current account ID:', error);
      throw error;
    }
  }

  /**
   * 获取当前AWS区域
   * @returns {string} AWS区域
   */
  static getCurrentRegion() {
    try {
      const command = 'aws configure get region';
      const region = execSync(command, { encoding: 'utf8' }).trim();
      return region || 'us-west-2'; // 默认区域
    } catch (error) {
      console.warn('Error getting current region, using default us-west-2:', error.message);
      return 'us-west-2';
    }
  }
}

module.exports = AWSHelpers;
