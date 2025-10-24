import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import './index.css';

// Ant Design 主题配置
const theme = {
  token: {
    colorPrimary: '#1890ff',
    borderRadius: 6,
    fontSize: 14,
  },
  components: {
    Card: {
      headerBg: '#fafafa',
    },
    Table: {
      headerBg: '#fafafa',
    },
  },
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <Provider store={store}>
      <ConfigProvider theme={theme}>
        <App />
      </ConfigProvider>
    </Provider>
  </React.StrictMode>
);
