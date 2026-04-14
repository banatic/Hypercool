import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './HelpPage.css';

interface ClaudeConfigResult {
  path: string;
  already_configured: boolean;
}

const CONFIG_JSON = `{
  "preferences": {
    "coworkScheduledTasksEnabled": false,
    "ccdScheduledTasksEnabled": true,
    "sidebarMode": "chat",
    "coworkWebSearchEnabled": true,
    "coworkOnboardingResumeStep": null
  },
  "mcpServers": {
    "hypercool": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3737/mcp"]
    }
  }
}`;

const CONFIG_PATH = `%LOCALAPPDATA%\\Packages`;

export const HelpPage = () => {
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [nodeInstalled, setNodeInstalled] = useState<boolean | null>(null);
  const [autoSetupState, setAutoSetupState] = useState<'idle' | 'loading' | 'success' | 'already' | 'error'>('idle');
  const [autoSetupTitle, setAutoSetupTitle] = useState('');
  const [autoSetupPath, setAutoSetupPath] = useState('');
  const [autoSetupError, setAutoSetupError] = useState('');

  useEffect(() => {
    invoke<boolean>('check_node_installed').then(setNodeInstalled).catch(() => setNodeInstalled(false));
  }, []);

  const copyConfig = () => {
    navigator.clipboard.writeText(CONFIG_JSON);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const copyPath = () => {
    navigator.clipboard.writeText(CONFIG_PATH);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const runAutoSetup = async () => {
    setAutoSetupState('loading');
    setAutoSetupTitle('');
    setAutoSetupPath('');
    setAutoSetupError('');
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
    <div className="help-page">
      <div className="help-header">
        <h2>AI 연동 도움말</h2>
        <p className="help-subtitle">
          Claude(클로드)라는 AI에게 쿨메신저 메시지를 바로 물어볼 수 있는 기능입니다.<br />
          한 번만 설정하면 됩니다!
        </p>
        <div className="help-screenshot help-screenshot-hero">
          <img
            src="https://github.com/user-attachments/assets/d337f2c8-3ffd-4edb-a91b-e16a9e8bac6c"
            alt="Claude에서 쿨메신저 메시지를 검색하는 화면"
          />
        </div>
      </div>

      <div className="help-steps">

        {/* Step 1 */}
        <div className="help-step">
          <div className="step-number">1</div>
          <div className="step-content">
            <h3>Claude 데스크탑 앱 설치하기</h3>
            <p>
              Anthropic이 만든 AI인 <strong>Claude</strong>의 PC 버전을 설치합니다.<br />
              아래 주소에서 <strong>Windows</strong> 버전을 다운로드해 설치하세요.
            </p>
            <div className="help-url-box">
              <span>https://claude.ai/download</span>
            </div>
            <p className="help-tip">💡 설치 후 회원가입(무료)이 필요합니다.</p>
          </div>
        </div>

        {/* Step 2: Node.js */}
        <div className="help-step">
          <div className="step-number">2</div>
          <div className="step-content">
            <h3>Node.js 설치하기</h3>
            {nodeInstalled === null && (
              <p className="help-tip">Node.js 설치 여부 확인 중...</p>
            )}
            {nodeInstalled === true && (
              <p className="node-ok">✅ Node.js가 설치되어 있습니다. 다음 단계로 넘어가세요!</p>
            )}
            {nodeInstalled === false && (
              <>
                <div className="node-warning">
                  <span className="node-warning-icon">⚠️</span>
                  <span>Node.js가 설치되어 있지 않습니다. AI 연동에 필요하므로 아래에서 설치해 주세요.</span>
                </div>
                <p>아래 주소에서 <strong>Windows</strong> 버전(LTS)을 다운로드해 설치하세요.</p>
                <div className="help-url-box">
                  <span>https://nodejs.org/ko/download</span>
                </div>
                <p className="help-tip">💡 설치 후 이 프로그램을 재시작하면 설치 여부가 다시 확인됩니다.</p>
              </>
            )}
          </div>
        </div>

        {/* Step 3 */}
        <div className="help-step">
          <div className="step-number">3</div>
          <div className="step-content">
            <h3>HyperCool을 먼저 실행하기</h3>
            <p>
              AI 연동 기능은 <strong>HyperCool이 켜져 있을 때만</strong> 동작합니다.<br />
              지금처럼 프로그램이 실행된 상태면 됩니다. ✅
            </p>
          </div>
        </div>

        {/* Auto Setup */}
        <div className="help-auto-setup">
          <div className="auto-setup-label">아래 버튼을 누르면 설정 파일을 자동으로 찾아서 업데이트합니다.</div>
          <button
            className={`auto-setup-btn auto-setup-btn--${autoSetupState}`}
            onClick={runAutoSetup}
            disabled={autoSetupState === 'loading'}
          >
            {autoSetupState === 'loading' && '설정 중...'}
            {autoSetupState === 'idle' && '자동 설정하기'}
            {autoSetupState === 'success' && '✓ 설정 완료'}
            {autoSetupState === 'already' && '✓ 이미 설정됨'}
            {autoSetupState === 'error' && '다시 시도'}
          </button>
          {(autoSetupTitle || autoSetupError) && (
            <div className={`auto-setup-result auto-setup-result--${autoSetupState === 'error' ? 'error' : autoSetupState === 'already' ? 'already' : 'ok'}`}>
              {autoSetupTitle && <div className="auto-setup-result-title">{autoSetupTitle}</div>}
              {autoSetupPath && <div className="auto-setup-result-path">{autoSetupPath}</div>}
              {autoSetupError && <div className="auto-setup-result-error">{autoSetupError}</div>}
            </div>
          )}
          <div className="auto-setup-divider">또는 아래 단계를 직접 따라하세요</div>
        </div>

        {/* Step 4 */}
        <div className="help-step">
          <div className="step-number">4</div>
          <div className="step-content">
            <h3>설정 파일 찾기</h3>
            <p>
              Claude 앱의 설정 파일 위치를 찾아야 합니다.<br />
              <strong>윈도우 탐색기</strong> 주소창에 아래 경로를 붙여넣고 Enter를 누르세요.
            </p>
            <div className="help-code-block">
              <code>%LOCALAPPDATA%\Packages</code>
              <button className={`help-copy-btn ${copiedPath ? 'copied' : ''}`} onClick={copyPath}>
                {copiedPath ? '복사됨 ✓' : '복사'}
              </button>
            </div>
            <p>
              열린 폴더에서 <strong>Claude_</strong>로 시작하는 폴더를 찾으세요.<br />
              (예: <code>Claude_pzs8sxrjxfjjc</code> — 이름은 PC마다 다를 수 있습니다)
            </p>
            <p>
              그 폴더 안의 <code>LocalCache\Roaming\Claude\</code> 경로로 이동하면<br />
              <strong>claude_desktop_config.json</strong> 파일이 있습니다.<br />
              없다면 새로 만드세요.
            </p>
            <p className="help-tip">💡 메모장으로 열면 됩니다. 파일 우클릭 → 연결 프로그램 → 메모장</p>
          </div>
        </div>

        {/* Step 5 */}
        <div className="help-step">
          <div className="step-number">5</div>
          <div className="step-content">
            <h3>설정 내용 붙여넣기</h3>
            <p>
              파일 안의 내용을 <strong>전부 지우고</strong> 아래 내용을 그대로 붙여넣으세요.
            </p>
            <div className="help-code-block config-block">
              <pre>{CONFIG_JSON}</pre>
              <button className={`help-copy-btn ${copiedConfig ? 'copied' : ''}`} onClick={copyConfig}>
                {copiedConfig ? '복사됨 ✓' : '복사'}
              </button>
            </div>
            <p>붙여넣은 뒤 <strong>저장</strong>(Ctrl+S)하고 메모장을 닫으세요.</p>
          </div>
        </div>

        {/* Step 6 */}
        <div className="help-step">
          <div className="step-number">6</div>
          <div className="step-content">
            <h3>Claude 앱 재시작하기</h3>
            <p>
              Claude 앱을 완전히 껐다가 다시 켜주세요.<br />
              작업표시줄 트레이에 Claude 아이콘이 있다면 우클릭 → <strong>종료</strong> 후 재실행하세요.
            </p>
          </div>
        </div>

        {/* Step 7 - Result */}
        <div className="help-step help-step-result">
          <div className="step-number">✓</div>
          <div className="step-content">
            <h3>이제 이렇게 사용할 수 있어요!</h3>
            <p>
              Claude에서 쿨메신저 메시지를 자연스럽게 물어보세요.
            </p>
            <div className="help-examples">
              <div className="help-example">"가정통신문 중에 급식비 관련된 거 찾아줘"</div>
              <div className="help-example">"학교에서 온 메시지 최근 10개 보여줘"</div>
              <div className="help-example">"현장학습 관련 공지 있었어?"</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
