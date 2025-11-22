/**
 * 简化的资源事件总线
 * 用于替代复杂的 globalRefreshManager 和 operationRefreshManager
 * 
 * 设计原则：
 * 1. 组件自己决定是否需要刷新（订阅事件）
 * 2. 操作按钮只负责触发事件（不关心谁刷新）
 * 3. 反转依赖关系，提高可维护性
 */

class ResourceEventBus {
  constructor() {
    this.listeners = new Map();
    this.enabled = true;
    this.debugMode = process.env.NODE_ENV === 'development';
  }

  /**
   * 组件订阅资源变化事件
   * @param {string} componentId - 组件唯一标识
   * @param {Function} callback - 刷新回调函数
   */
  subscribe(componentId, callback) {
    this.listeners.set(componentId, callback);
    
    if (this.debugMode) {
      console.log(`[ResourceEventBus] ${componentId} subscribed`);
    }
  }

  /**
   * 取消订阅
   * @param {string} componentId - 组件唯一标识
   */
  unsubscribe(componentId) {
    this.listeners.delete(componentId);
    
    if (this.debugMode) {
      console.log(`[ResourceEventBus] ${componentId} unsubscribed`);
    }
  }

  /**
   * 触发资源变化事件
   * @param {string} eventType - 事件类型（可选，用于日志）
   * @param {Object} metadata - 事件元数据（可选）
   */
  emit(eventType = 'resource-changed', metadata = {}) {
    if (!this.enabled) {
      if (this.debugMode) {
        console.log(`[ResourceEventBus] Event bus disabled, skipping emit: ${eventType}`);
      }
      return;
    }

    if (this.debugMode) {
      console.log(`[ResourceEventBus] Emitting event: ${eventType}`, metadata);
    }

    // 通知所有订阅者
    this.listeners.forEach((callback, componentId) => {
      try {
        callback(eventType, metadata);
        
        if (this.debugMode) {
          console.log(`[ResourceEventBus] ${componentId} refreshed`);
        }
      } catch (error) {
        console.error(`[ResourceEventBus] Error refreshing ${componentId}:`, error);
      }
    });
  }

  /**
   * 启用/禁用事件总线
   * @param {boolean} enabled - 是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[ResourceEventBus] Event bus ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 获取当前订阅者列表
   */
  getSubscribers() {
    return Array.from(this.listeners.keys());
  }

  /**
   * 清空所有订阅者
   */
  clear() {
    this.listeners.clear();
    console.log('[ResourceEventBus] All subscribers cleared');
  }
}

// 创建全局单例
const resourceEventBus = new ResourceEventBus();

// 开发环境下暴露到 window 对象
if (process.env.NODE_ENV === 'development') {
  window.resourceEventBus = resourceEventBus;
}

export default resourceEventBus;
