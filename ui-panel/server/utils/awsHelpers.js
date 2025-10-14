const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 获取当前AWS配置的region
 * @returns {Promise<string>} AWS region
 */
async function getCurrentRegion() {
  return new Promise((resolve, reject) => {
    exec('aws configure get region', (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to get AWS region:', error);
        resolve('us-west-1'); // 默认region
        return;
      }
      
      const region = stdout.trim();
      resolve(region || 'us-west-1');
    });
  });
}

/**
 * 获取当前S3 bucket名称
 * @returns {string} S3 bucket name
 */
function getCurrentS3Bucket() {
  try {
    const metadataPath = '/s3-workspace-metadata';
    if (fs.existsSync(metadataPath)) {
      const files = fs.readdirSync(metadataPath);
      const bucketFile = files.find(file => file.startsWith('CURRENT_BUCKET_'));
      if (bucketFile) {
        return bucketFile.replace('CURRENT_BUCKET_', '');
      }
    }
  } catch (error) {
    console.log('Could not read s3-workspace-metadata:', error.message);
  }
  return '';
}

/**
 * 获取当前role ARN
 * @returns {Promise<string>} current role ARN
 */
async function getDevAdminRoleArn() {
  return new Promise((resolve, reject) => {
    exec('aws sts get-caller-identity --query "Arn" --output text', (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to get current role ARN:', error);
        resolve(''); // 返回空字符串作为默认值
        return;
      }
      
      const callerArn = stdout.trim();
      // 从 assumed-role ARN 中提取实际的 role ARN
      // 格式: arn:aws:sts::account:assumed-role/role-name/session-name
      // 转换为: arn:aws:iam::account:role/role-name
      if (callerArn.includes('assumed-role')) {
        const parts = callerArn.split('/');
        if (parts.length >= 2) {
          const roleName = parts[1];
          const accountId = callerArn.split(':')[4];
          const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
          resolve(roleArn);
          return;
        }
      }
      
      resolve(callerArn || '');
    });
  });
}

/**
 * 获取当前AWS账户ID
 * @returns {Promise<string>} AWS account ID
 */
async function getCurrentAccountId() {
  return new Promise((resolve, reject) => {
    exec('aws sts get-caller-identity --query "Account" --output text', (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to get AWS account ID:', error);
        reject(new Error(`Failed to get AWS account ID: ${error.message}`));
        return;
      }
      
      const accountId = stdout.trim();
      resolve(accountId);
    });
  });
}

module.exports = {
  getCurrentRegion,
  getCurrentS3Bucket,
  getDevAdminRoleArn,
  getCurrentAccountId
};
