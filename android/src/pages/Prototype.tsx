/**
 * 静态原型页面 - 展示界面交互
 */

import { useState, useRef } from 'react';

// ============================================
// 类型定义
// ============================================
interface QuickKey {
  label: string;
  value: string;
}

interface Session {
  id: number;
  name: string;
  host: string;
  status: 'connected' | 'connecting' | 'idle';
}

// ============================================
// 终端显示组件（自适应高度）
// ============================================
function TerminalDisplay({ showKeyboard, showQuickKeyboard }: { showKeyboard: boolean; showQuickKeyboard: boolean }) {
  const terminalRef = useRef<HTMLDivElement>(null);

  // 计算终端高度：总高度 - 快捷栏(44) - 快捷键盘(180?) - 命令输入栏(44?) - 系统键盘(?)
  const terminalHeight = showQuickKeyboard ? '180px' : showKeyboard ? '280px' : '320px';

  // 模拟终端输出
  const lines = [
    'Last login: Fri Apr 18 14:00:00 2026 from 192.168.1.1',
    '',
    'fanzhang@Macstudio ~ % ',
  ];

  return (
    <div
      ref={terminalRef}
      style={{
        backgroundColor: '#000',
        color: '#fff',
        fontFamily: 'Menlo, Monaco, monospace',
        fontSize: '14px',
        padding: '12px',
        height: terminalHeight,
        overflowY: 'auto',
        lineHeight: '1.5',
        transition: 'height 0.3s ease',
      }}
    >
      {lines.map((line, i) => (
        <div key={i}>
          {i === lines.length - 1 ? (
            <>
              <span style={{ color: '#4caf50' }}>fanzhang@Macstudio</span>
              <span style={{ color: '#888' }}> ~ </span>
              <span style={{ color: '#fff' }}>% </span>
              <span style={{
                backgroundColor: '#fff',
                color: '#000',
                padding: '0 2px',
                display: 'inline-block',
                minWidth: '8px',
              }}>█</span>
            </>
          ) : line}
        </div>
      ))}
    </div>
  );
}

// ============================================
// 快捷栏工具行
// ============================================
function QuickBar({
  showQuickKeyboard,
  setShowQuickKeyboard,
  showSessionSwitch,
  setShowSessionSwitch,
  setShowEditPanel,
  setShowKeyboard,
}: {
  showQuickKeyboard: boolean;
  setShowQuickKeyboard: (v: boolean) => void;
  showSessionSwitch: boolean;
  setShowSessionSwitch: (v: boolean) => void;
  setShowEditPanel: (v: boolean) => void;
  setShowKeyboard: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      backgroundColor: '#1a1a1a',
      padding: '8px 4px',
      borderBottom: '1px solid #333',
      gap: '4px',
    }}>
      {/* Session 切换按钮 */}
      <button
        onClick={() => setShowSessionSwitch(!showSessionSwitch)}
        style={{
          backgroundColor: showSessionSwitch ? '#4caf50' : '#333',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          padding: '6px 12px',
          fontSize: '12px',
          fontWeight: 'bold',
          cursor: 'pointer',
        }}
      >
        Tab
      </button>

      {/* 功能键 */}
      {['ESC', 'TAB', 'CTRL', 'ALT'].map(key => (
        <button key={key} style={{
          backgroundColor: '#333',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          padding: '6px 10px',
          fontSize: '12px',
          fontWeight: 'bold',
          cursor: 'pointer',
        }}>
          {key}
        </button>
      ))}

      {/* 分隔线 */}
      <div style={{ width: '1px', height: '20px', backgroundColor: '#555', margin: '0 4px' }} />

      {/* 编辑按钮 - 点击进入编辑界面 */}
      <button
        onClick={() => setShowEditPanel(true)}
        style={{
          backgroundColor: '#333',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          padding: '6px 8px',
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        ✏️
      </button>

      {/* 更多按钮 */}
      <button style={{
        backgroundColor: '#333',
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        padding: '6px 8px',
        fontSize: '12px',
        cursor: 'pointer',
      }}>
        ⋯
      </button>

      {/* 快捷键盘切换 - 点击切换显示 */}
      <button
        onClick={() => {
          setShowQuickKeyboard(!showQuickKeyboard);
          setShowKeyboard(!showQuickKeyboard); // 同时切换系统键盘
        }}
        style={{
          backgroundColor: showQuickKeyboard ? '#4caf50' : '#333',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          padding: '6px 8px',
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        ⌨️
      </button>

      {/* 布局按钮 */}
      <button style={{
        backgroundColor: '#333',
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        padding: '6px 8px',
        fontSize: '12px',
        cursor: 'pointer',
      }}>
        ▦
      </button>
    </div>
  );
}

// ============================================
// 快捷键盘面板
// ============================================
function QuickKeyboard({ visible }: { visible: boolean }) {
  if (!visible) return null;

  const rows: QuickKey[][] = [
    [{ label: 'PgUp', value: '\x1b[5~' }, { label: 'PgDn', value: '\x1b[6~' }, { label: 'Ins', value: '\x1b[2~' }, { label: 'Del', value: '\x1b[3~' }, { label: 'HOME', value: '\x1b[H' }, { label: 'END', value: '\x1b[F' }, { label: '$', value: '$' }, { label: '|', value: '|' }],
    [{ label: '!', value: '!' }, { label: '&', value: '&' }, { label: '@', value: '@' }, { label: '#', value: '#' }, { label: '=', value: '=' }, { label: ':', value: ':' }, { label: ';', value: ';' }, { label: '%', value: '%' }],
    [{ label: '~', value: '~' }, { label: '*', value: '*' }, { label: '(', value: '(' }, { label: ')', value: ')' }, { label: '[', value: '[' }, { label: ']', value: ']' }, { label: '{', value: '{' }, { label: '}', value: '}' }],
    [{ label: "'", value: "'" }, { label: '"', value: '"' }, { label: '<', value: '<' }, { label: '>', value: '>' }, { label: 'F1', value: '\x1bOP' }, { label: 'F2', value: '\x1bOQ' }, { label: 'F3', value: '\x1bOR' }, { label: 'F4', value: '\x1bOS' }],
    [{ label: 'F5', value: '\x1b[15~' }, { label: 'F6', value: '\x1b[17~' }, { label: 'F7', value: '\x1b[18~' }, { label: 'F8', value: '\x1b[19~' }, { label: 'F9', value: '\x1b[20~' }, { label: 'F10', value: '\x1b[21~' }, { label: 'F11', value: '\x1b[23~' }, { label: 'F12', value: '\x1b[24~' }],
  ];

  return (
    <div style={{
      backgroundColor: '#222',
      padding: '8px 4px',
    }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
          {row.map(key => (
            <button key={key.label} style={{
              backgroundColor: '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 4px',
              fontSize: '11px',
              fontWeight: 'bold',
              cursor: 'pointer',
              width: 'calc((100% - 28px) / 8)',
            }}>
              {key.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ============================================
// 命令输入栏
// ============================================
function CommandInputBar() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      backgroundColor: '#1a1a1a',
      padding: '8px',
      gap: '8px',
    }}>
      <input
        type="text"
        placeholder="输入命令..."
        style={{
          backgroundColor: '#333',
          color: '#fff',
          border: '1px solid #555',
          borderRadius: '4px',
          padding: '8px 12px',
          fontSize: '14px',
          flex: 1,
          outline: 'none',
        }}
      />
      <button style={{
        backgroundColor: '#4caf50',
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        padding: '8px 16px',
        fontSize: '14px',
        fontWeight: 'bold',
        cursor: 'pointer',
      }}>
        ▶
      </button>
    </div>
  );
}

// ============================================
// 系统键盘占位
// ============================================
function SystemKeyboardPlaceholder({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div style={{
      backgroundColor: '#d0d0d5',
      padding: '12px 8px',
      borderTop: '1px solid #aaa',
    }}>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'].map(k => (
          <button key={k} style={{
            backgroundColor: '#fff',
            color: '#000',
            border: 'none',
            borderRadius: '4px',
            padding: '12px',
            fontSize: '14px',
            fontWeight: 'bold',
            width: 'calc((100% - 54px) / 10)',
          }}>
            {k}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', paddingLeft: '20px' }}>
        {['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'].map(k => (
          <button key={k} style={{
            backgroundColor: '#fff',
            color: '#000',
            border: 'none',
            borderRadius: '4px',
            padding: '12px',
            fontSize: '14px',
            fontWeight: 'bold',
            width: 'calc((100% - 54px) / 9)',
          }}>
            {k}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '6px', paddingLeft: '30px' }}>
        {['Z', 'X', 'C', 'V', 'B', 'N', 'M'].map(k => (
          <button key={k} style={{
            backgroundColor: '#fff',
            color: '#000',
            border: 'none',
            borderRadius: '4px',
            padding: '12px',
            fontSize: '14px',
            fontWeight: 'bold',
            width: 'calc((100% - 48px) / 7)',
          }}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================
// Session 切换面板
// ============================================
function SessionSwitchPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  if (!visible) return null;

  const sessions: Session[] = [
    { id: 1, name: 'Macstudio', host: 'localhost', status: 'connected' },
    { id: 2, name: 'Work Server', host: '192.168.1.100', status: 'idle' },
    { id: 3, name: 'AWS EC2', host: 'ec2.aws.com', status: 'connecting' },
  ];

  return (
    <div style={{
      position: 'absolute',
      top: '44px',
      left: '4px',
      backgroundColor: '#222',
      borderRadius: '8px',
      padding: '8px',
      minWidth: '180px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      zIndex: 100,
    }}>
      <div style={{
        color: '#888',
        fontSize: '12px',
        marginBottom: '8px',
        textAlign: 'center',
      }}>
        Sessions (3)
      </div>
      {sessions.map(s => (
        <div key={s.id} style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px',
          backgroundColor: '#333',
          borderRadius: '4px',
          marginBottom: '4px',
          cursor: 'pointer',
        }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: s.status === 'connected' ? '#4caf50' : s.status === 'connecting' ? '#ff9800' : '#888',
            marginRight: '8px',
          }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold' }}>{s.name}</div>
            <div style={{ color: '#888', fontSize: '11px' }}>{s.host}</div>
          </div>
          <span style={{ color: '#888', fontSize: '11px' }}>
            {s.status === 'connected' ? '●' : s.status === 'connecting' ? '⋯' : '○'}
          </span>
        </div>
      ))}
      <button style={{
        backgroundColor: '#4caf50',
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        padding: '8px 12px',
        fontSize: '12px',
        fontWeight: 'bold',
        cursor: 'pointer',
        marginTop: '8px',
        width: '100%',
      }}>
        + New Session
      </button>
      <button
        onClick={onClose}
        style={{
          backgroundColor: '#333',
          color: '#888',
          border: 'none',
          borderRadius: '4px',
          padding: '4px 8px',
          fontSize: '11px',
          cursor: 'pointer',
          marginTop: '4px',
          width: '100%',
        }}
      >
        关闭
      </button>
    </div>
  );
}

// ============================================
// 快捷键编辑界面
// ============================================
function QuickKeyEditPanel({ onClose }: { onClose: () => void }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');

  const defaultKeys: QuickKey[] = [
    { label: 'Ctrl+C', value: '\x03' },
    { label: 'Ctrl+D', value: '\x04' },
    { label: 'Ctrl+Z', value: '\x1a' },
    { label: 'Ctrl+L', value: '\x0c' },
  ];

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: '#000',
      zIndex: 200,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* 顶部导航 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        backgroundColor: '#111',
        padding: '12px',
        borderBottom: '1px solid #333',
      }}>
        <button onClick={onClose} style={{
          backgroundColor: '#333',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          padding: '8px 16px',
          fontSize: '12px',
          cursor: 'pointer',
        }}>
          ← 返回
        </button>
        <span style={{ color: '#fff', fontSize: '14px', fontWeight: 'bold', marginLeft: '12px' }}>
          快捷键编辑
        </span>
        <button style={{
          backgroundColor: '#4caf50',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          padding: '8px 16px',
          fontSize: '12px',
          cursor: 'pointer',
          marginLeft: 'auto',
        }}>
          保存
        </button>
      </div>

      {/* 当前快捷键列表 */}
      <div style={{ padding: '12px', flex: 1 }}>
        <div style={{ color: '#888', fontSize: '12px', marginBottom: '12px' }}>
          预设快捷键（点击编辑）
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
          {defaultKeys.map(key => (
            <button
              key={key.label}
              onClick={() => {
                setEditingKey(key.label);
                setNewLabel(key.label);
                setNewValue(key.value);
              }}
              style={{
                backgroundColor: editingKey === key.label ? '#4caf50' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                padding: '12px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              {key.label}
            </button>
          ))}
        </div>

        {/* 编辑区域 */}
        {editingKey && (
          <div style={{
            marginTop: '20px',
            padding: '12px',
            backgroundColor: '#222',
            borderRadius: '8px',
          }}>
            <div style={{ color: '#888', fontSize: '12px', marginBottom: '8px' }}>
              编辑 "{editingKey}"
            </div>
            <div style={{ marginBottom: '8px' }}>
              <label style={{ color: '#fff', fontSize: '12px', display: 'block', marginBottom: '4px' }}>
                显示名称
              </label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={{
                  backgroundColor: '#333',
                  color: '#fff',
                  border: '1px solid #555',
                  borderRadius: '4px',
                  padding: '8px',
                  fontSize: '14px',
                  width: '100%',
                }}
              />
            </div>
            <div style={{ marginBottom: '8px' }}>
              <label style={{ color: '#fff', fontSize: '12px', display: 'block', marginBottom: '4px' }}>
                发送值（转义序列）
              </label>
              <input
                type="text"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="如 \x03 表示 Ctrl+C"
                style={{
                  backgroundColor: '#333',
                  color: '#fff',
                  border: '1px solid #555',
                  borderRadius: '4px',
                  padding: '8px',
                  fontSize: '14px',
                  width: '100%',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setEditingKey(null)}
                style={{
                  backgroundColor: '#333',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
              <button
                onClick={() => setEditingKey(null)}
                style={{
                  backgroundColor: '#4caf50',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                应用
              </button>
            </div>
          </div>
        )}

        {/* 添加新快捷键 */}
        <div style={{ marginTop: '20px' }}>
          <button style={{
            backgroundColor: '#333',
            color: '#4caf50',
            border: '1px solid #4caf50',
            borderRadius: '4px',
            padding: '12px',
            fontSize: '12px',
            fontWeight: 'bold',
            cursor: 'pointer',
            width: '100%',
          }}>
            + 添加新快捷键
          </button>
        </div>

        {/* 快捷键面板管理 */}
        <div style={{ marginTop: '20px' }}>
          <div style={{ color: '#888', fontSize: '12px', marginBottom: '12px' }}>
            面板布局
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={{
              backgroundColor: '#4caf50',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '12px',
              cursor: 'pointer',
            }}>
              默认面板
            </button>
            <button style={{
              backgroundColor: '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '12px',
              cursor: 'pointer',
            }}>
              特殊字符
            </button>
            <button style={{
              backgroundColor: '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '12px',
              cursor: 'pointer',
            }}>
              F键
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// 主原型组件
// ============================================
export default function Prototype() {
  const [showQuickKeyboard, setShowQuickKeyboard] = useState(false);
  const [showSessionSwitch, setShowSessionSwitch] = useState(false);
  const [showEditPanel, setShowEditPanel] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(true);

  // 当前界面状态描述
  const getStatusText = () => {
    if (showEditPanel) return '快捷键编辑界面';
    if (showSessionSwitch) return 'Session 切换弹出';
    if (showQuickKeyboard) return '快捷键盘展开';
    return '正常界面（系统键盘显示）';
  };

  return (
    <div style={{
      maxWidth: '375px',
      margin: '20px auto',
      border: '1px solid #333',
      borderRadius: '12px',
      overflow: 'hidden',
      backgroundColor: '#000',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      {/* 顶部说明（非按钮） */}
      <div style={{
        padding: '12px',
        backgroundColor: '#111',
        borderBottom: '1px solid #333',
      }}>
        <div style={{ color: '#888', fontSize: '11px', marginBottom: '4px' }}>
          当前状态：{getStatusText()}
        </div>
        <div style={{ color: '#fff', fontSize: '12px' }}>
          点击下方快捷栏按钮切换状态
        </div>
      </div>

      {/* 手机模拟器 */}
      <div style={{ position: 'relative' }}>
        {/* 状态栏 */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 12px',
          backgroundColor: '#111',
          color: '#fff',
          fontSize: '12px',
        }}>
          <span>14:00</span>
          <span>●●●●●</span>
          <span>100%</span>
        </div>

        {/* Session 切换面板 */}
        <SessionSwitchPanel
          visible={showSessionSwitch}
          onClose={() => setShowSessionSwitch(false)}
        />

        {/* 终端显示（自适应高度） */}
        <TerminalDisplay
          showKeyboard={showKeyboard}
          showQuickKeyboard={showQuickKeyboard}
        />

        {/* 快捷栏 */}
        <QuickBar
          showQuickKeyboard={showQuickKeyboard}
          setShowQuickKeyboard={setShowQuickKeyboard}
          showSessionSwitch={showSessionSwitch}
          setShowSessionSwitch={setShowSessionSwitch}
          setShowEditPanel={setShowEditPanel}
          setShowKeyboard={setShowKeyboard}
        />

        {/* 快捷键盘面板 */}
        <QuickKeyboard visible={showQuickKeyboard} />

        {/* 命令输入栏（仅在系统键盘显示时） */}
        {showKeyboard && !showQuickKeyboard && <CommandInputBar />}

        {/* 系统键盘占位 */}
        <SystemKeyboardPlaceholder visible={showKeyboard && !showQuickKeyboard} />
      </div>

      {/* 快捷键编辑界面（全屏覆盖） */}
      {showEditPanel && (
        <QuickKeyEditPanel onClose={() => setShowEditPanel(false)} />
      )}
    </div>
  );
}
