import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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

interface BriefingStatus {
  enabled: boolean;
  claude_installed: boolean;
  claude_path: string | null;
  authed: boolean;
  running: boolean;
  last_run_at: string | null;
  last_new_count: number;
  last_error: string | null;
  last_seen_id: number;
}

interface BriefingRunResult {
  ran: boolean;
  new_count: number;
  skipped: number;
  error: string | null;
  reason: string | null;
}

function formatRunTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function describeRun(r: BriefingRunResult): string {
  if (r.error) return `오류: ${r.error}`;
  if (!r.ran) return r.reason || '실행하지 않았습니다.';
  return `완료 · 신규 ${r.new_count}건${r.skipped ? ` (건너뜀 ${r.skipped})` : ''}`;
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
  const [briefing, setBriefing] = useState<BriefingStatus | null>(null);
  const [briefingToggling, setBriefingToggling] = useState(false);
  const [briefingRunning, setBriefingRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [debugRunning, setDebugRunning] = useState(false);
  const [debugResult, setDebugResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, st, b] = await Promise.all([
        invoke<McpStatus>('get_mcp_status'),
        invoke<EdufineStats>('get_edufine_stats'),
        invoke<BriefingStatus>('get_briefing_agent_status'),
      ]);
      setStatus(s);
      setEdufineDocCount(st.total_docs);
      setBriefing(b);
    } catch (e) {
      console.error('MCP 상태 로드 실패:', e);
    }
  }, []);

  useEffect(() => {
    load();
    invoke<boolean>('check_node_installed').then(setNodeInstalled).catch(() => setNodeInstalled(false));
  }, [load]);

  // 브리핑 에이전트 실행 상태 갱신(자동 실행/완료 시 백엔드가 emit).
  useEffect(() => {
    const unlisten = listen('briefing-status', () => {
      invoke<BriefingStatus>('get_briefing_agent_status').then(setBriefing).catch(() => {});
    });
    return () => { void unlisten.then(u => u()); };
  }, []);

  const toggleBriefing = async () => {
    if (!briefing || briefingToggling || !briefing.claude_installed) return;
    setBriefingToggling(true);
    try {
      await invoke('set_briefing_agent_enabled', { enabled: !briefing.enabled });
      const s = await invoke<BriefingStatus>('get_briefing_agent_status');
      setBriefing(s);
    } catch (e) {
      console.error('브리핑 토글 실패:', e);
    } finally {
      setBriefingToggling(false);
    }
  };

  const runBriefingNow = async () => {
    if (briefingRunning || debugRunning || !briefing?.claude_installed) return;
    setBriefingRunning(true);
    setRunResult(null);
    try {
      const r = await invoke<BriefingRunResult>('run_briefing_agent_now');
      setRunResult(describeRun(r));
      const s = await invoke<BriefingStatus>('get_briefing_agent_status');
      setBriefing(s);
    } catch (e: unknown) {
      setRunResult(`오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBriefingRunning(false);
    }
  };

  // 디버그: 저장된 진행 위치를 바꾸지 않고 최근 10개 메시지로 강제 1회 실행(중복 자동 제외).
  const runBriefingDebug = async () => {
    if (briefingRunning || debugRunning || !briefing?.claude_installed) return;
    setDebugRunning(true);
    setDebugResult(null);
    try {
      const r = await invoke<BriefingRunResult>('run_briefing_agent_debug', { count: 10 });
      setDebugResult(describeRun(r));
    } catch (e: unknown) {
      setDebugResult(`오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDebugRunning(false);
    }
  };

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

  const briefingSub = !briefing?.claude_installed
    ? 'Claude Code CLI 미설치'
    : briefing.enabled
      ? (briefing.last_error
          ? `오류: ${briefing.last_error.slice(0, 40)}`
          : briefing.last_run_at
            ? `마지막 실행: ${formatRunTime(briefing.last_run_at)} · 신규 ${briefing.last_new_count}건`
            : '활성화됨 · 새 메시지 대기 중')
      : '비활성화';

  return (
    <div className="mcp-page">
      <div className="mcp-header">
        <h2>AI 연동 관리</h2>
        <p className="mcp-subtitle">
          쿨메신저·에듀파인 데이터를 Claude가 활용하도록 연결하고, 새 메시지를 자동으로 일정화합니다.
        </p>
        <div className="mcp-server-pill">
          <span className="mcp-dot mcp-dot--on" />
          <span>MCP 서버 실행 중</span>
          <code>localhost:{status?.port ?? 3737}</code>
        </div>
      </div>

      <div className="mcp-sections">
        {/* ── 그룹 1: 데이터 소스 ───────────────────────────── */}
        <div className="mcp-group">
          <div className="mcp-group-label">
            <span className="mcp-group-label-text">데이터 소스</span>
            <span className="mcp-group-label-desc">Claude가 읽을 수 있는 정보 (읽기 전용)</span>
          </div>

          {/* 쿨메신저 */}
          <div className="mcp-section">
            <div className="mcp-section-header">
              <div className="mcp-section-icon mcp-section-icon--msg">
                💬<span className="mcp-status-dot mcp-status-dot--on" />
              </div>
              <div className="mcp-section-text">
                <div className="mcp-section-title">쿨메신저 메시지</div>
                <div className="mcp-section-sub">받은 메시지·첨부를 검색·조회</div>
              </div>
              <span className="mcp-always-on">항상 켜짐</span>
            </div>
          </div>

          {/* 에듀파인 */}
          <div className="mcp-section">
            <div className="mcp-section-header">
              <div className="mcp-section-icon mcp-section-icon--doc">
                📄<span className={`mcp-status-dot ${status?.edufine_enabled ? 'mcp-status-dot--on' : 'mcp-status-dot--off'}`} />
              </div>
              <div className="mcp-section-text">
                <div className="mcp-section-title">에듀파인 공문</div>
                <div className="mcp-section-sub">
                  {status?.edufine_enabled ? `공문 ${edufineDocCount}개 저장됨` : '비활성화'}
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
        </div>

        {/* ── 그룹 2: 자동화 ────────────────────────────────── */}
        <div className="mcp-group">
          <div className="mcp-group-label">
            <span className="mcp-group-label-text">자동화</span>
            <span className="mcp-group-label-desc">HyperCool 안에서 동작</span>
          </div>

          {/* 새 메시지 자동 일정화 (AI 브리핑) */}
          <div className="mcp-section">
            <div className="mcp-section-header">
              <div className="mcp-section-icon mcp-section-icon--ai">
                📅<span className={`mcp-status-dot ${briefing?.enabled ? 'mcp-status-dot--on' : 'mcp-status-dot--off'}`} />
              </div>
              <div className="mcp-section-text">
                <div className="mcp-section-title">
                  새 메시지 자동 일정화<span className="mcp-badge-ai">AI</span>
                </div>
                <div className="mcp-section-sub">{briefingSub}</div>
              </div>
              <button
                className={`mcp-toggle ${briefing?.enabled ? 'mcp-toggle--on' : 'mcp-toggle--off'}`}
                onClick={toggleBriefing}
                disabled={briefingToggling || !briefing?.claude_installed}
              >
                <span className="mcp-toggle-knob" />
              </button>
            </div>

            <div className="mcp-briefing-body">
              <div className="mcp-briefing-desc">
                새 쿨메신저 메시지가 오면 <strong>Claude Code</strong>가 내용·첨부를 읽어 할 일·마감을
                자동으로 추출해 <strong>달력</strong>에 등록합니다. 로컬에서 실행되며 메시지를 <strong>읽기만</strong> 하고,
                쓰기는 내 달력에만 합니다. 새 메시지 감지 후 약 45초 모아 한 번 실행합니다.
                <br />
                Claude 구독 로그인 또는 <code>ANTHROPIC_API_KEY</code>가 필요합니다. AI가 만든 일정은 보라색으로 표시됩니다.
              </div>

              {!briefing?.claude_installed && (
                <div className="mcp-node-warning">
                  <span>⚠️</span>
                  <span>Claude Code CLI가 설치되어 있지 않습니다. 이 기능에 필요합니다.<br />
                    <strong>https://claude.ai/download</strong> 또는 <code>npm i -g @anthropic-ai/claude-code</code> 설치 후 앱을 재시작하세요.</span>
                </div>
              )}
              {briefing?.claude_installed && !briefing.authed && (
                <div className="mcp-node-warning">
                  <span>🔑</span>
                  <span>Claude 인증이 확인되지 않았습니다. 터미널에서 <code>claude</code> 로그인 또는 <code>ANTHROPIC_API_KEY</code> 설정이 필요합니다.</span>
                </div>
              )}

              {briefing?.enabled && (
                <div className="mcp-run-row">
                  <button
                    className="mcp-run-btn"
                    onClick={runBriefingNow}
                    disabled={briefingRunning || debugRunning || !briefing.claude_installed}
                  >
                    {briefingRunning ? '실행 중…' : '지금 실행'}
                  </button>
                  {runResult && (
                    <span className={`mcp-run-result ${runResult.startsWith('오류') ? 'mcp-run-result--error' : ''}`}>
                      {runResult}
                    </span>
                  )}
                </div>
              )}

              {/* 디버그: 최근 10개로 강제 실행(진행 위치 미변경) */}
              {briefing?.claude_installed && (
                <div className="mcp-debug-box">
                  <div className="mcp-debug-label">🧪 테스트</div>
                  <div className="mcp-run-row">
                    <button
                      className="mcp-run-btn mcp-run-btn--ghost"
                      onClick={runBriefingDebug}
                      disabled={briefingRunning || debugRunning}
                    >
                      {debugRunning ? '테스트 중…' : '최근 10개 메시지로 실행'}
                    </button>
                    {debugResult && (
                      <span className={`mcp-run-result ${debugResult.startsWith('오류') ? 'mcp-run-result--error' : ''}`}>
                        {debugResult}
                      </span>
                    )}
                  </div>
                  <div className="mcp-debug-hint">
                    저장된 진행 위치(마지막 처리 지점)를 바꾸지 않고 최근 메시지로 동작을 시험합니다. 이미 등록된 일정은 자동으로 제외됩니다.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── 그룹 3: 외부 AI 연결 ──────────────────────────── */}
        <div className="mcp-group">
          <div className="mcp-group-label">
            <span className="mcp-group-label-text">외부 AI 연결</span>
            <span className="mcp-group-label-desc">Claude Desktop 등에서 물어보기</span>
          </div>

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
    </div>
  );
};
