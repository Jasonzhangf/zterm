/**
 * HostForm - 主机添加/编辑表单
 */

import { useState, useEffect } from 'react';
import { DEFAULT_BRIDGE_PORT } from '../lib/mobile-config';
import type { Host } from '../lib/types';

interface HostFormProps {
  host?: Host;  // 编辑时传入现有主机
  onSave: (host: Omit<Host, 'id' | 'createdAt'>) => void;
  onCancel: () => void;
}

export function HostForm({ host, onSave, onCancel }: HostFormProps) {
  const [name, setName] = useState(host?.name || '');
  const [hostname, setHostname] = useState(host?.bridgeHost || '');
  const [port, setPort] = useState(host?.bridgePort || DEFAULT_BRIDGE_PORT);
  const [sessionName, setSessionName] = useState(host?.sessionName || '');
  const [authType, setAuthType] = useState<'password' | 'key'>(host?.authType || 'password');
  const [password, setPassword] = useState(host?.password || '');
  const [privateKey, setPrivateKey] = useState(host?.privateKey || '');
  const [autoCommand, setAutoCommand] = useState(host?.autoCommand || '');
  const [tags, setTags] = useState<string[]>(host?.tags || []);
  const [pinned, setPinned] = useState(host?.pinned || false);
  const [tagInput, setTagInput] = useState('');

  // 编辑模式时填充数据
  useEffect(() => {
    if (host) {
      setName(host.name);
      setHostname(host.bridgeHost);
      setPort(host.bridgePort);
      setSessionName(host.sessionName);
      setAuthType(host.authType);
      setPassword(host.password || '');
      setPrivateKey(host.privateKey || '');
      setAutoCommand(host.autoCommand || '');
      setTags(host.tags || []);
      setPinned(host.pinned);
    }
  }, [host]);

  const handleSubmit = () => {
    if (!name || !hostname) {
      alert('请填写必填字段：名称、bridge 主机地址');
      return;
    }

    onSave({
      name,
      bridgeHost: hostname,
      bridgePort: port,
      sessionName,
      authType,
      password: authType === 'password' ? password : undefined,
      privateKey: authType === 'key' ? privateKey : undefined,
      autoCommand,
      tags,
      pinned,
      lastConnected: host?.lastConnected,
    });
  };

  const handleAddTag = () => {
    if (tagInput && !tags.includes(tagInput)) {
      setTags([...tags, tagInput]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: '#000',
      color: '#fff',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* 标题栏 */}
      <div style={{
        padding: '16px',
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid #333',
      }}>
        <button
          onClick={onCancel}
          style={{
            backgroundColor: '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            padding: '8px 16px',
            cursor: 'pointer',
          }}
        >
          取消
        </button>
        <span style={{
          flex: 1,
          textAlign: 'center',
          fontSize: '18px',
          fontWeight: 'bold',
        }}>
          {host ? '编辑主机' : '添加主机'}
        </span>
        <button
          onClick={handleSubmit}
          style={{
            backgroundColor: '#4caf50',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            padding: '8px 16px',
            cursor: 'pointer',
          }}
        >
          保存
        </button>
      </div>

      {/* 表单内容 */}
      <div style={{
        flex: 1,
        padding: '16px',
        overflowY: 'auto',
      }}>
        {/* 名称 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            名称 *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：本机 Mac"
            style={{
              width: '100%',
              backgroundColor: '#1a1a1a',
              color: '#fff',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '12px',
              fontSize: '16px',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 主机地址 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            主机地址 *
          </label>
          <input
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="例如：100.66.1.82 或 macstudio.tail..."
            style={{
              width: '100%',
              backgroundColor: '#1a1a1a',
              color: '#fff',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '12px',
              fontSize: '16px',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 端口 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            Bridge 端口
          </label>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(parseInt(e.target.value, 10) || DEFAULT_BRIDGE_PORT)}
            style={{
              width: '100%',
              backgroundColor: '#1a1a1a',
              color: '#fff',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '12px',
              fontSize: '16px',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 会话名 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            Tmux 会话名
          </label>
          <input
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder="例如：fin"
            style={{
              width: '100%',
              backgroundColor: '#1a1a1a',
              color: '#fff',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '12px',
              fontSize: '16px',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 认证方式 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            认证方式
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setAuthType('password')}
              style={{
                flex: 1,
                backgroundColor: authType === 'password' ? '#4caf50' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                padding: '12px',
                cursor: 'pointer',
              }}
            >
              密码
            </button>
            <button
              onClick={() => setAuthType('key')}
              style={{
                flex: 1,
                backgroundColor: authType === 'key' ? '#4caf50' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                padding: '12px',
                cursor: 'pointer',
              }}
            >
              密钥
            </button>
          </div>
        </div>

        {/* 密码/密钥 */}
        {authType === 'password' ? (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            Bridge 密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入 bridge 密码"
              style={{
                width: '100%',
                backgroundColor: '#1a1a1a',
                color: '#fff',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '12px',
                fontSize: '16px',
                boxSizing: 'border-box',
              }}
            />
          </div>
        ) : (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
              Bridge 私钥
            </label>
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="粘贴 bridge 私钥内容"
              rows={4}
              style={{
                width: '100%',
                backgroundColor: '#1a1a1a',
                color: '#fff',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '12px',
                fontSize: '14px',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
          </div>
        )}

        {/* 自动命令 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            连接后自动执行命令
          </label>
          <input
            type="text"
            value={autoCommand}
            onChange={(e) => setAutoCommand(e.target.value)}
            placeholder="例如：tmux attach -t main"
            style={{
              width: '100%',
              backgroundColor: '#1a1a1a',
              color: '#fff',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '12px',
              fontSize: '16px',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 标签 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>
            标签分组
          </label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="输入标签"
              style={{
                flex: 1,
                backgroundColor: '#1a1a1a',
                color: '#fff',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '12px',
                fontSize: '16px',
              }}
            />
            <button
              onClick={handleAddTag}
              style={{
                backgroundColor: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                padding: '12px 16px',
                cursor: 'pointer',
              }}
            >
              添加
            </button>
          </div>
          {tags.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {tags.map(tag => (
                <span
                  key={tag}
                  onClick={() => handleRemoveTag(tag)}
                  style={{
                    backgroundColor: '#4caf50',
                    color: '#fff',
                    padding: '4px 12px',
                    borderRadius: '12px',
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  {tag} ×
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 置顶 */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              style={{ width: '20px', height: '20px' }}
            />
            <span>置顶显示</span>
          </label>
        </div>
      </div>
    </div>
  );
}
