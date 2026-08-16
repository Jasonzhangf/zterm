/**
 * HostList - 主机列表组件
 */

import { Host } from '../lib/types';

interface HostListProps {
  hosts: Host[];
  onConnect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onAddNew: () => void;
}

export function HostList({ hosts, onConnect, onEdit, onDelete, onAddNew }: HostListProps) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#000',
      padding: '16px',
      paddingBottom: '80px', // 底部留空
    }}>
      {/* 标题和添加按钮 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '16px',
      }}>
        <h2 style={{
          color: '#fff',
          fontSize: '18px',
          margin: 0,
        }}>
          主机列表
        </h2>
        <button
          onClick={onAddNew}
          style={{
            backgroundColor: '#4caf50',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            padding: '12px 20px',
            fontSize: '14px',
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          + 添加主机
        </button>
      </div>

      {/* 空状态 */}
      {hosts.length === 0 && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
          gap: '16px',
        }}>
          <div style={{ fontSize: '48px' }}>📡</div>
          <div style={{ fontSize: '16px' }}>暂无主机配置</div>
          <div style={{ fontSize: '14px', color: '#888' }}>
            点击右上角"添加主机"开始配置
          </div>
        </div>
      )}

      {/* 主机列表 */}
      {hosts.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}>
          {hosts.map(host => (
            <div
              key={host.id}
              style={{
                backgroundColor: '#111',
                borderRadius: '12px',
                padding: '16px',
                border: '1px solid #333',
              }}
            >
              {/* 主机名称和状态 */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '8px',
              }}>
                <span style={{
                  color: '#fff',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}>
                  {host.name}
                </span>
                {host.pinned && (
                  <span style={{
                    color: '#ffd700',
                    fontSize: '12px',
                  }}>
                    ⭐ 置顶
                  </span>
                )}
              </div>

              {/* 主机信息 */}
              <div style={{
                color: '#888',
                fontSize: '13px',
                marginBottom: '12px',
              }}>
                {host.bridgeHost}:{host.bridgePort} · {host.sessionName || host.name}
              </div>

              {/* 操作按钮 */}
              <div style={{
                display: 'flex',
                gap: '8px',
              }}>
                <button
                  onClick={() => onConnect(host)}
                  style={{
                    flex: 1,
                    backgroundColor: '#4caf50',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '12px',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  连接
                </button>
                <button
                  onClick={() => onEdit(host)}
                  style={{
                    backgroundColor: '#333',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '12px',
                    fontSize: '14px',
                    cursor: 'pointer',
                  }}
                >
                  编辑
                </button>
                <button
                  onClick={() => onDelete(host)}
                  style={{
                    backgroundColor: '#f44336',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '12px',
                    fontSize: '14px',
                    cursor: 'pointer',
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
