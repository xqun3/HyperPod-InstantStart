import React, { useState } from 'react';
import { Tabs, Space } from 'antd';
import {
  ExperimentOutlined,
  RocketOutlined,
  FireOutlined,
  CodeOutlined,
  CloudOutlined
} from '@ant-design/icons';
import TrainingConfigPanel from './TrainingConfigPanel';
import VerlRecipePanel from './VerlRecipePanel';
import TorchRecipePanel from './TorchRecipePanel';
import ScriptRecipePanel from './ScriptRecipePanel';
import SageMakerJobPanel from './SageMakerJobPanel';
import { useHyperPodInstanceTypes } from '../utils/hyperPodInstanceTypes';

const { TabPane } = Tabs;

const HyperPodRecipes = ({ onLaunch, deploymentStatus }) => {
  const [activeTab, setActiveTab] = useState('torch');
  const showScriptRecipe = process.env.REACT_APP_SHOW_SCRIPT_RECIPE === 'true';

  // 🚀 预先获取所有HyperPod实例类型，避免Tab切换时的延迟
  const { instanceTypes: hyperPodInstanceTypes, loading: instanceTypesLoading } = useHyperPodInstanceTypes();

  const handleTabChange = (key) => {
    setActiveTab(key);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Tabs 
        activeKey={activeTab} 
        onChange={handleTabChange}
        type="card"
        size="small"
        tabBarStyle={{ marginBottom: 16, flexShrink: 0 }}
        style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        {showScriptRecipe && (
          <TabPane
            tab={
              <Space>
                <CodeOutlined />
                Script Recipe
              </Space>
            }
            key="script"
            style={{ height: '100%', overflow: 'hidden' }}
          >
            <div style={{ height: '100%', overflow: 'auto', paddingRight: '8px' }}>
              <ScriptRecipePanel
                onLaunch={onLaunch}
                deploymentStatus={deploymentStatus}
                hyperPodInstanceTypes={hyperPodInstanceTypes}
                instanceTypesLoading={instanceTypesLoading}
              />
            </div>
          </TabPane>
        )}

        <TabPane
          tab={
            <Space>
              <FireOutlined />
              Torch Recipe
            </Space>
          }
          key="torch"
          style={{ height: '100%', overflow: 'hidden' }}
        >
          <div style={{ height: '100%', overflow: 'auto', paddingRight: '8px' }}>
            <TorchRecipePanel
              onLaunch={onLaunch}
              deploymentStatus={deploymentStatus}
              hyperPodInstanceTypes={hyperPodInstanceTypes}
              instanceTypesLoading={instanceTypesLoading}
            />
          </div>
        </TabPane>

        <TabPane
          tab={
            <Space>
              <ExperimentOutlined />
              LlamaFactory Recipe
            </Space>
          }
          key="llamafactory"
          style={{ height: '100%', overflow: 'hidden' }}
        >
          <div style={{ height: '100%', overflow: 'auto', paddingRight: '8px' }}>
            <TrainingConfigPanel
              onLaunch={onLaunch}
              deploymentStatus={deploymentStatus}
              hyperPodInstanceTypes={hyperPodInstanceTypes}
              instanceTypesLoading={instanceTypesLoading}
            />
          </div>
        </TabPane>
        
        <TabPane
          tab={
            <Space>
              <RocketOutlined />
              VERL Recipe
            </Space>
          }
          key="verl"
          style={{ height: '100%', overflow: 'hidden' }}
        >
          <div style={{ height: '100%', overflow: 'auto', paddingRight: '8px' }}>
            <VerlRecipePanel
              onLaunch={onLaunch}
              deploymentStatus={deploymentStatus}
              hyperPodInstanceTypes={hyperPodInstanceTypes}
              instanceTypesLoading={instanceTypesLoading}
            />
          </div>
        </TabPane>

        <TabPane
          tab={
            <Space>
              <CloudOutlined />
              SageMakerJob
            </Space>
          }
          key="sagemaker"
          style={{ height: '100%', overflow: 'hidden' }}
        >
          <div style={{ height: '100%', overflow: 'auto', paddingRight: '8px' }}>
            <SageMakerJobPanel onLaunch={onLaunch} deploymentStatus={deploymentStatus} />
          </div>
        </TabPane>
      </Tabs>
    </div>
  );
};

export default HyperPodRecipes;
