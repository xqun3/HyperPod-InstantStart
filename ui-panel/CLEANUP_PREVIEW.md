# 🧹 Advanced Scaling Preview 清理指南

这个文档说明如何完全移除Advanced Scaling预览功能，恢复到原始状态。

## 📋 需要删除的文件

### 1. 删除预览组件文件
```bash
rm client/src/components/AdvancedScalingPanelPreview.js
rm client/src/components/AdvancedScalingPanelPreview.css
rm client/src/components/AdvancedScalingPanelV2.js
rm client/src/components/AdvancedScalingPanelV2.css
```

### 2. 恢复App.js文件

在 `client/src/App.js` 中找到并删除以下内容：

#### 删除import语句（第21-22行）
```javascript
// 🎨 PREVIEW ONLY - Remove this import to clean up preview
import AdvancedScalingPanelV2 from './components/AdvancedScalingPanelV2';
```

#### 删除预览标签页（第800-812行）
```javascript
// 🎨 PREVIEW ONLY - Remove this tab to clean up preview
{
  key: 'advanced-scaling-preview',
  label: (
    <Space>
      Advanced Scaling
      <Badge count="PREVIEW" style={{ backgroundColor: '#ff4d4f' }} />
    </Space>
  ),
  children: (
    <AdvancedScalingPanelV2
      onDeploy={handleAdvancedScalingDeploy}
      deploymentStatus={deploymentStatus}
    />
  )
},
```

## 🚀 自动清理脚本

或者直接运行以下命令自动清理：

```bash
# 进入ui-panel目录
cd ui-panel

# 删除预览组件文件
rm -f client/src/components/AdvancedScalingPanelPreview.js
rm -f client/src/components/AdvancedScalingPanelPreview.css
rm -f client/src/components/AdvancedScalingPanelV2.js
rm -f client/src/components/AdvancedScalingPanelV2.css

# 使用sed删除App.js中的预览相关代码
sed -i '/🎨 PREVIEW ONLY/,+1d' client/src/App.js
sed -i '/key: '\''advanced-scaling-preview'\''/,+11d' client/src/App.js

echo "✅ Advanced Scaling预览功能已完全移除"
```

## ✅ 验证清理结果

清理完成后，检查以下内容确保完全移除：

1. **文件检查**：确认预览组件文件已删除
   ```bash
   ls client/src/components/AdvancedScalingPanel*
   # 应该显示 "No such file or directory"
   ```

2. **App.js检查**：确认没有预览相关代码
   ```bash
   grep -n "PREVIEW\|AdvancedScalingPanel" client/src/App.js
   # 应该没有任何输出
   ```

3. **重启开发服务器**：确保应用正常运行
   ```bash
   npm run dev
   ```

## 🔄 如果需要恢复预览

如果您想恢复预览功能，可以从git历史中恢复相关文件：

```bash
git checkout HEAD~1 -- client/src/components/AdvancedScalingPanelPreview.js
git checkout HEAD~1 -- client/src/components/AdvancedScalingPanelPreview.css
git checkout HEAD~1 -- client/src/App.js
```

---

**注意**：这个预览功能的设计是完全无耦合的，清理后不会影响项目的任何现有功能。