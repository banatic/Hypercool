import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './McpPage.css';

interface McpStatus {
  server_running: boolean;
  port: number;
  edufine_enabled: boolean;
  edufine_running: boolean;
}

interface EdufineStats {
  total_docs: number;
  last_detected_at: string | null;
  watch_dir: string;
}

interface ClaudeConfigResult {
  path: string;
  already_configured: boolean;
}

const CONFIG_JSON = `{
  "mcpServers": {
    "hypercool": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3737/mcp"]
    }
  }
}`;

export const McpPage = () => {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [edufineDocCount, setEdufineDocCount] = useState(0);
  const [edufineToggling, setEdufineToggling] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [nodeInstalled, setNodeInstalled] = useState<boolean | null>(null);
  const [autoSetupState, setAutoSetupState] = useState<'idle' | 'loading' | 'success' | 'already' | 'error'>('idle');
  const [autoSetupTitle, setAutoSetupTitle] = useState('');
  const [autoSetupPath, setAutoSetupPath] = useState('');
  const [autoSetupError, setAutoSetupError] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        invoke<McpStatus>('get_mcp_status'),
        invoke<EdufineStats>('get_edufine_stats'),
      ]);
      setStatus(s);
      setEdufineDocCount(st.total_docs);
    } catch (e) {
      console.error('MCP 상태 로드 실패:', e);
    }
  }, []);

  useEffect(() => {
    load();
    invoke<boolean>('check_node_installed').then(setNodeInstalled).catch(() => setNodeInstalled(false));
  }, [load]);

  const toggleEdufine = async () => {
    if (!status || edufineToggling) return;
    setEdufineToggling(true);
    try {
      await invoke('toggle_edufine_mcp', { enabled: !status.edufine_enabled });
      await load();
    } catch (e) {
      console.error('에듀파인 MCP 토글 실패:', e);
    } finally {
      setEdufineToggling(false);
    }
  };

  const copyConfig = () => {
    navigator.clipboard.writeText(CONFIG_JSON);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const copyPath = () => {
    navigator.clipboard.writeText('%LOCALAPPDATA%\\Packages');
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const runAutoSetup = async () => {
    setAutoSetupState('loading');
    setAutoSetupTitle(''); setAutoSetupPath(''); setAutoSetupError('');
    try {
      const result = await invoke<ClaudeConfigResult>('setup_claude_mcp');
      setAutoSetupPath(result.path);
      if (result.already_configured) {
        setAutoSetupState('already');
        setAutoSetupTitle('이미 설정되어 있습니다.');
      } else {
        setAutoSetupState('success');
        setAutoSetupTitle('설정 완료! Claude를 재시작하세요.');
      }
    } catch (e: unknown) {
      setAutoSetupState('error');
      setAutoSetupError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mcp-page">
      <div className="mcp-header">
        <h2>AI 연동 관리</h2>
      </div>

      <div className="mcp-sections">
        {/* 쿨메신저 섹션 */}
        <div className="mcp-section">
          <div className="mcp-section-header">
            <span className="mcp-dot mcp-dot--on" />
            <div className="mcp-section-text">
              <div className="mcp-section-title">쿨메신저 메시지</div>
              <div className="mcp-section-sub">항상 활성화</div>
            </div>
          </div>
        </div>

        {/* 에듀파인 섹션 */}
        <div className="mcp-section">
          <div className="mcp-section-header">
            <span className={`mcp-dot ${status?.edufine_enabled ? 'mcp-dot--on' : 'mcp-dot--off'}`} />
            <div className="mcp-section-text">
              <div className="mcp-section-title">에듀파인 공문</div>
              <div className="mcp-section-sub">
                {status?.edufine_enabled
                  ? `공문 ${edufineDocCount}개 저장됨`
                  : '비활성화'}
              </div>
            </div>
            <button
              className={`mcp-toggle ${status?.edufine_enabled ? 'mcp-toggle--on' : 'mcp-toggle--off'}`}
              onClick={toggleEdufine}
              disabled={edufineToggling}
            >
              <span className="mcp-toggle-knob" />
            </button>
          </div>

          {!status?.edufine_enabled && (
            <div className="mcp-edufine-hint">
              활성화하면 에듀파인에서 공문을 열 때 자동으로 저장됩니다.
            </div>
          )}
        </div>

        {/* 도움말 */}
        <div className="mcp-section mcp-section--help">
          <button className="mcp-section-header mcp-section-header--btn" onClick={() => setShowHelp(v => !v)}>
            <span className="mcp-help-icon">?</span>
            <div className="mcp-section-text">
              <div className="mcp-section-title">Claude Desktop 연결 방법</div>
              <div className="mcp-section-sub">한 번만 설정하면 됩니다</div>
            </div>
            <span className="mcp-chevron">{showHelp ? '▲' : '▼'}</span>
          </button>

          {showHelp && (
            <div className="mcp-help-body">
              <div className="mcp-auto-setup">
                <div className="mcp-auto-setup-label">아래 버튼으로 설정 파일을 자동으로 업데이트합니다.</div>
                <button
                  className={`mcp-auto-setup-btn mcp-auto-setup-btn--${autoSetupState}`}
                  onClick={runAutoSetup}
                  disabled={autoSetupState === 'loading'}
                >
                  {autoSetupState === 'loading' ? '설정 중...'
                    : autoSetupState === 'success' ? '✓ 설정 완료'
                    : autoSetupState === 'already' ? '✓ 이미 설정됨'
                    : autoSetupState === 'error' ? '다시 시도'
                    : '자동 설정하기'}
                </button>
                {(autoSetupTitle || autoSetupError) && (
                  <div className={`mcp-auto-setup-result mcp-auto-setup-result--${autoSetupState === 'error' ? 'error' : 'ok'}`}>
                    {autoSetupTitle && <div className="mcp-auto-setup-result-title">{autoSetupTitle}</div>}
                    {autoSetupPath && <div className="mcp-auto-setup-result-path">{autoSetupPath}</div>}
                    {autoSetupError && <div className="mcp-auto-setup-result-error">{autoSetupError}</div>}
                  </div>
                )}
                <div className="mcp-auto-setup-divider">또는 직접 설정하기</div>
              </div>

              {nodeInstalled === false && (
                <div className="mcp-node-warning">
                  <span>⚠️</span>
                  <span>Node.js가 설치되어 있지 않습니다. AI 연동에 필요합니다.<br />
                    <strong>https://nodejs.org/ko/download</strong> 에서 설치 후 재시작하세요.</span>
                </div>
              )}
              {nodeInstalled === true && <div className="mcp-node-ok">✅ Node.js 설치 확인됨</div>}

              <div className="mcp-help-steps">
                <div className="mcp-help-step">
                  <span className="mcp-step-num">1</span>
                  <div>
                    <div className="mcp-step-title">Claude Desktop 설치</div>
                    <div className="mcp-step-desc"><strong>https://claude.ai/download</strong> 에서 Windows 버전을 설치하세요.</div>
                  </div>
                </div>
                <div className="mcp-help-step">
                  <span className="mcp-step-num">2</span>
                  <div>
                    <div className="mcp-step-title">설정 파일 찾기</div>
                    <div className="mcp-step-desc">탐색기 주소창에 붙여넣고 Enter:</div>
                    <div className="mcp-code-block">
                      <code>%LOCALAPPDATA%\Packages</code>
                      <button className={`mcp-copy-btn ${copiedPath ? 'copied' : ''}`} onClick={copyPath}>
                        {copiedPath ? '복사됨 ✓' : '복사'}
                      </button>
                    </div>
                    <div className="mcp-step-desc">
                      <code>Claude_</code>로 시작하는 폴더 → <code>LocalCache\Roaming\Claude\claude_desktop_config.json</code>
                    </div>
                  </div>
                </div>
                <div className="mcp-help-step">
                  <span className="mcp-step-num">3</span>
                  <div>
                    <div className="mcp-step-title">설정 내용 붙여넣기</div>
                    <div className="mcp-step-desc">파일 전체 내용을 아래로 교체 후 저장:</div>
                    <div className="mcp-code-block mcp-code-block--pre">
                      <pre>{CONFIG_JSON}</pre>
                      <button className={`mcp-copy-btn ${copiedConfig ? 'copied' : ''}`} onClick={copyConfig}>
                        {copiedConfig ? '복사됨 ✓' : '복사'}
                      </button>
                    </div>
                  </div>
                </div>
                <div className="mcp-help-step">
                  <span className="mcp-step-num">4</span>
                  <div>
                    <div className="mcp-step-title">Claude 재시작</div>
                    <div className="mcp-step-desc">Claude를 완전히 종료 후 재실행하세요. 이제 쿨메신저 메시지와 에듀파인 공문을 바로 물어볼 수 있습니다!</div>
                  </div>
                </div>
              </div>

              <div className="mcp-examples">
                <div className="mcp-examples-title">이렇게 물어보세요</div>
                <div className="mcp-example">"가정통신문 중에 급식비 관련된 거 찾아줘"</div>
                <div className="mcp-example">"학교에서 온 메시지 최근 10개 보여줘"</div>
                {status?.edufine_enabled && (
                  <>
                    <div className="mcp-example">"최근 에듀파인 공문 목록 알려줘"</div>
                    <div className="mcp-example">"교육과정 관련 공문 검색해줘"</div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
