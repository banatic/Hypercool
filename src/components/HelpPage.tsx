import { useState } from 'react';
import './HelpPage.css';

const CONFIG_JSON = `{
  "mcpServers": {
    "hypercool": {
      "url": "http://localhost:3737/mcp"
    }
  }
}`;



export const HelpPage = () => {
  const [copiedConfig, setCopiedConfig] = useState(false);

  const copyConfig = () => {
    navigator.clipboard.writeText(CONFIG_JSON);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
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

        {/* Step 2 */}
        <div className="help-step">
          <div className="step-number">2</div>
          <div className="step-content">
            <h3>HyperCool을 먼저 실행하기</h3>
            <p>
              AI 연동 기능은 <strong>HyperCool이 켜져 있을 때만</strong> 동작합니다.<br />
              지금처럼 프로그램이 실행된 상태면 됩니다. ✅
            </p>
          </div>
        </div>

        {/* Step 3 */}
        <div className="help-step">
          <div className="step-number">3</div>
          <div className="step-content">
            <h3>설정 파일 열기</h3>
            <p>
              Claude 앱의 설정 파일을 수정해야 합니다.<br />
              <strong>윈도우 탐색기</strong> 주소창에 아래 경로를 붙여넣고 Enter를 누르세요.
            </p>
            <div className="help-code-block">
              <code>%APPDATA%\Claude</code>
              <button className="help-copy-btn" onClick={() => { navigator.clipboard.writeText('%APPDATA%\\Claude'); }}>
                복사
              </button>
            </div>
            <p>
              해당 폴더에 <strong>claude_desktop_config.json</strong> 파일이 있을 겁니다.<br />
              없다면 새로 만드세요. (파일명 그대로 <code>claude_desktop_config.json</code>)
            </p>
            <p className="help-tip">💡 메모장으로 열면 됩니다. 파일 우클릭 → 연결 프로그램 → 메모장</p>
          </div>
        </div>

        {/* Step 4 */}
        <div className="help-step">
          <div className="step-number">4</div>
          <div className="step-content">
            <h3>설정 내용 붙여넣기</h3>
            <p>
              파일 안의 내용을 <strong>전부 지우고</strong> 아래 내용을 붙여넣으세요.<br />
              기존에 내용이 있다면 <code>"mcpServers"</code> 부분만 추가하면 됩니다.
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

        {/* Step 5 */}
        <div className="help-step">
          <div className="step-number">5</div>
          <div className="step-content">
            <h3>Claude 앱 재시작하기</h3>
            <p>
              Claude 앱을 완전히 껐다가 다시 켜주세요.<br />
              작업표시줄 트레이에 Claude 아이콘이 있다면 우클릭 → <strong>종료</strong> 후 재실행하세요.
            </p>
          </div>
        </div>

        {/* Step 6 - Result */}
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
