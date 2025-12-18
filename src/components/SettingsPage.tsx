import React, { useState, useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { PageHeader } from './PageHeader';
import { AuthLanding } from './AuthLanding';
import { invoke } from '@tauri-apps/api/core';

interface SettingsPageProps {
  udbPath: string;
  setUdbPath: (path: string) => void;
  pickUdb: () => Promise<void>;
  saveToRegistry: (key: string, value: string) => Promise<void>;
  classTimes: string[];
  setClassTimes: (times: string[]) => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
  onSync: () => Promise<void>;
  lastSyncTime: string | null;
  isLoadingSync?: boolean;
  syncProgress?: { current: number; total: number } | null;
  syncError?: string | null;
}

const REG_KEY_UDB = 'UdbPath';
const REG_KEY_CLASS_TIMES = 'ClassTimes';
const REG_KEY_UI_SCALE = 'UIScale';
const REG_KEY_AUTO_START = 'AutoStart';
const REG_KEY_AUTO_START_HIDE_MAIN = 'AutoStartHideMain';
const REG_KEY_AUTO_START_CALENDAR = 'AutoStartCalendar';
const REG_KEY_AUTO_START_SCHOOL = 'AutoStartSchool';

export const SettingsPage: React.FC<SettingsPageProps> = ({
  udbPath,
  setUdbPath,
  pickUdb,
  saveToRegistry,
  classTimes,
  setClassTimes,
  uiScale,
  setUiScale,
  onSync,
  lastSyncTime,
  isLoadingSync,
  syncProgress,
  syncError
}) => {
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; date: string; body: string } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isLatestVersion, setIsLatestVersion] = useState(false);
  const [updateLogs, setUpdateLogs] = useState<Array<{ time: string; message: string; type: 'info' | 'error' | 'success' }>>([]);
  
  // 자동 실행 설정 상태
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartHideMain, setAutoStartHideMain] = useState(false);
  const [autoStartCalendar, setAutoStartCalendar] = useState(false);
  const [autoStartSchool, setAutoStartSchool] = useState(false);
  
  // 설정 불러오기
  useEffect(() => {
    const loadAutoStartSettings = async () => {
      try {
        const autoStartValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START });
        setAutoStart(autoStartValue === 'true');
        
        const hideMainValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START_HIDE_MAIN });
        setAutoStartHideMain(hideMainValue === 'true');
        
        const calendarValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START_CALENDAR });
        setAutoStartCalendar(calendarValue === 'true');
        
        const schoolValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START_SCHOOL });
        setAutoStartSchool(schoolValue === 'true');
      } catch (error) {
        console.error('자동 실행 설정 불러오기 실패:', error);
      }
    };
    loadAutoStartSettings();
  }, []);

  const addClassTime = () => {
    const newTime = '0900-0950';
    setClassTimes([...classTimes, newTime]);
  };

  const removeClassTime = (index: number) => {
    setClassTimes(classTimes.filter((_, i) => i !== index));
  };

  const updateClassTime = (index: number, value: string) => {
    const newTimes = [...classTimes];
    newTimes[index] = value;
    setClassTimes(newTimes);
  };

  const saveClassTimes = () => {
    saveToRegistry(REG_KEY_CLASS_TIMES, JSON.stringify(classTimes));
  };



  const addUpdateLog = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    setUpdateLogs(prev => {
      const newLogs = [...prev, { time: timeStr, message, type }];
      // 최대 100개까지만 유지
      return newLogs.slice(-100);
    });
    console.log(`[${timeStr}] ${message}`);
  };

  const checkForUpdates = async () => {
    setIsCheckingUpdate(true);
    setUpdateInfo(null);
    setUpdateProgress(null);
    setIsLatestVersion(false);
    setUpdateLogs([]);
    addUpdateLog('업데이트 확인 중...', 'info');
    try {
      const update = await check();
      if (update) {
        addUpdateLog(`업데이트 발견: 버전 ${update.version}`, 'success');
        addUpdateLog(`발행 날짜: ${update.date || '알 수 없음'}`, 'info');
        if (update.body) {
          addUpdateLog(`변경 사항: ${update.body.substring(0, 100)}${update.body.length > 100 ? '...' : ''}`, 'info');
        }
        setUpdateInfo({
          version: update.version,
          date: update.date || '',
          body: update.body || '',
        });
        setIsLatestVersion(false);
      } else {
        addUpdateLog('최신 버전입니다.', 'success');
        setUpdateInfo(null);
        setIsLatestVersion(true);
        // alert('최신 버전입니다.'); // Removed
      }
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || '알 수 없는 오류';
      addUpdateLog(`업데이트 확인 중 오류: ${errorMessage}`, 'error');
      console.error('업데이트 확인 중 오류:', error);
      setUpdateInfo(null);
      setIsLatestVersion(false);
      // alert('업데이트 확인 중 오류가 발생했습니다.'); // Removed
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const downloadAndInstallUpdate = async () => {
    if (!updateInfo) return;
    
    setIsInstalling(true);
    setUpdateProgress({ downloaded: 0, total: 0 });
    addUpdateLog('업데이트 다운로드 시작...', 'info');
    
    try {
      const update = await check();
      if (!update) {
        addUpdateLog('업데이트를 찾을 수 없습니다.', 'error');
        // alert('업데이트를 찾을 수 없습니다.'); // Removed
        setIsInstalling(false);
        setUpdateProgress(null);
        return;
      }

      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            setUpdateProgress({ downloaded: 0, total: contentLength });
            const sizeMB = (contentLength / 1024 / 1024).toFixed(2);
            addUpdateLog(`다운로드 시작: ${sizeMB} MB`, 'info');
            console.log(`started downloading ${event.data.contentLength ?? 0} bytes`);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength ?? 0;
            setUpdateProgress({ downloaded, total: contentLength });
            const progressPercent = Math.round((downloaded / contentLength) * 100);
            if (progressPercent % 10 === 0 || downloaded === contentLength) {
              addUpdateLog(`다운로드 진행: ${progressPercent}% (${(downloaded / 1024 / 1024).toFixed(2)} MB / ${(contentLength / 1024 / 1024).toFixed(2)} MB)`, 'info');
            }
            console.log(`downloaded ${downloaded} from ${contentLength}`);
            break;
          case 'Finished':
            addUpdateLog('다운로드 완료', 'success');
            addUpdateLog('설치 시작...', 'info');
            console.log('download finished');
            break;
        }
      });

      addUpdateLog('설치 완료. 앱을 재시작합니다...', 'success');
      console.log('update installed');
      await relaunch();
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || '알 수 없는 오류';
      addUpdateLog(`업데이트 설치 중 오류: ${errorMessage}`, 'error');
      console.error('업데이트 설치 중 오류:', error);
      // alert('업데이트 설치 중 오류가 발생했습니다.'); // Removed
      setIsInstalling(false);
      setUpdateProgress(null);
    }
  };

  return (
    <div className="settings page-content">
      <PageHeader title="설정" />
      
      <div className="field field-horizontal">
        <label>계정 및 동기화</label>
        <div className="auth-landing-container">
          <AuthLanding 
            onSync={() => onSync()} 
            lastSyncTime={lastSyncTime}
            isLoadingSync={isLoadingSync}
            syncProgress={syncProgress}
            syncError={syncError}
          />
        </div>
      </div>
      <div className="field-description" style={{ textAlign: 'right', marginTop: '-8px', marginBottom: '16px' }}>
        동기화가 완료된 일정과 메시지는 <a href="https://hypercool-fe1fa.web.app/" target="_blank" rel="noopener noreferrer">hypercool-fe1fa.web.app</a>에서 확인할 수 있습니다.
      </div>

      <div className="field">
        <label>업데이트</label>
        <div className="update-container">
          <div className="row" style={{ marginBottom: isLatestVersion || updateInfo ? '12px' : '0' }}>
            <button 
              onClick={checkForUpdates} 
              disabled={isCheckingUpdate || isInstalling}
              className="check-update-btn"
            >
              {isCheckingUpdate ? '확인 중...' : '업데이트 확인'}
            </button>
            {isLatestVersion && (
              <span className="update-status-text success">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                최신 버전입니다.
              </span>
            )}
          </div>
          
          {updateInfo && (
            <div className="update-info-box">
              <div className="update-info-header">
                <span className="new-version-badge">NEW</span>
                <span className="new-version-number">v{updateInfo.version}</span>
                <span className="new-version-date">{updateInfo.date}</span>
              </div>
              {updateInfo.body && (
                <div className="update-info-body">
                  <pre>{updateInfo.body}</pre>
                </div>
              )}
              
              {updateProgress ? (
                <div className="update-progress-container">
                  <div className="update-progress-info">
                    <span>다운로드 중...</span>
                    <span>{Math.round((updateProgress.downloaded / updateProgress.total) * 100)}%</span>
                  </div>
                  <div className="update-progress-bar">
                    <div 
                      className="update-progress-fill"
                      style={{ 
                        width: `${(updateProgress.downloaded / updateProgress.total) * 100}%`
                      }} 
                    />
                  </div>
                </div>
              ) : (
                !isInstalling && (
                  <button 
                    className="update-install-btn"
                    onClick={downloadAndInstallUpdate}
                    disabled={isCheckingUpdate}
                  >
                    다운로드 및 설치
                  </button>
                )
              )}
              
              {isInstalling && (
                <div className="update-installing-text">
                  설치 중... 완료 후 자동으로 재시작됩니다.
                </div>
              )}
            </div>
          )}
          
          {updateLogs.length > 0 && (
            <div className="update-logs">
              <div className="update-logs-header">
                <span>로그</span>
                <button onClick={() => setUpdateLogs([])}>지우기</button>
              </div>
              <div className="update-logs-content">
                {updateLogs.map((log, index) => (
                  <div key={index} className={`update-log-item ${log.type}`}>
                    <span className="time">{log.time}</span>
                    <span className="message">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="udbPathInput">UDB 경로</label>
        <div className="row">
          <input id="udbPathInput" type="text" value={udbPath} onChange={(e) => setUdbPath(e.target.value)} placeholder="C:\...\your.udb" />
          <button onClick={pickUdb}>찾기</button>
          <button onClick={() => saveToRegistry(REG_KEY_UDB, udbPath)}>저장</button>
        </div>
      </div>

      <div className="field">
        <label>수업 시간</label>
        <div className="class-times-container">
          <div className="class-time-header">
            <span className="col-period">교시</span>
            <span className="col-time">시작 시간</span>
            <span className="col-sep"></span>
            <span className="col-time">종료 시간</span>
            <span className="col-action"></span>
          </div>
          <div className="class-times-list">
            {classTimes.map((time, index) => {
              const [start, end] = time.split('-');
              const startTime = start ? `${start.substring(0, 2)}:${start.substring(2, 4)}` : '';
              const endTime = end ? `${end.substring(0, 2)}:${end.substring(2, 4)}` : '';

              return (
                <div key={index} className="class-time-row">
                  <span className="period-label">{index + 1}교시</span>
                  <input
                    type="time"
                    className="time-input"
                    value={startTime}
                    onChange={(e) => {
                      const newStart = e.target.value.replace(':', '');
                      updateClassTime(index, `${newStart}-${end}`);
                    }}
                  />
                  <span className="time-sep">~</span>
                  <input
                    type="time"
                    className="time-input"
                    value={endTime}
                    onChange={(e) => {
                      const newEnd = e.target.value.replace(':', '');
                      updateClassTime(index, `${start}-${newEnd}`);
                    }}
                  />
                  <button onClick={() => removeClassTime(index)} className="icon-btn remove-btn" title="삭제">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12"></path>
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="row" style={{ marginTop: '12px' }}>
          <button onClick={addClassTime} className="add-time-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            수업 시간 추가
          </button>
          <button onClick={saveClassTimes}>저장</button>
        </div>
        <div className="field-description">
          수업 시간 동안에는 새로운 메시지가 와도 창이 자동으로 표시되지 않습니다.
        </div>
      </div>

      <div className="field">
        <label htmlFor="uiScaleInput">UI 배율</label>
        <div className="row">
          <input 
            id="uiScaleInput" 
            type="range" 
            min="0.5" 
            max="2.0" 
            step="0.1" 
            value={uiScale} 
            onChange={(e) => {
              const newScale = parseFloat(e.target.value);
              setUiScale(newScale);
              saveToRegistry(REG_KEY_UI_SCALE, newScale.toString());
            }}
            style={{ flex: 1 }}
          />
          <span className="ui-scale-value">{(uiScale * 100).toFixed(0)}%</span>
        </div>
        <div className="field-description">
          전체 UI의 크기를 조정합니다. (50% ~ 200%)
        </div>
      </div>

      <div className="field">
        <label>자동 실행 설정</label>
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={async (e) => {
                const value = e.target.checked;
                setAutoStart(value);
                await invoke('set_auto_start', { enabled: value });
                await saveToRegistry(REG_KEY_AUTO_START, value.toString());
              }}
            />
            <span>윈도우 시작 시 자동 실행</span>
          </label>
          <div className="field-description">
            Windows 시작 시 프로그램이 자동으로 실행됩니다.
          </div>
        </div>
        {autoStart && (
          <div className="setting-sub-items">
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoStartHideMain}
                  onChange={async (e) => {
                    const value = e.target.checked;
                    setAutoStartHideMain(value);
                    await saveToRegistry(REG_KEY_AUTO_START_HIDE_MAIN, value.toString());
                  }}
                />
                <span>자동 실행 시 메인 윈도우 숨기기</span>
              </label>
              <div className="field-description">
                자동 실행 시 메인 윈도우를 트레이로 숨깁니다.
              </div>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoStartCalendar}
                  onChange={async (e) => {
                    const value = e.target.checked;
                    setAutoStartCalendar(value);
                    await saveToRegistry(REG_KEY_AUTO_START_CALENDAR, value.toString());
                  }}
                />
                <span>프로그램 실행 시 달력 위젯 자동 실행</span>
              </label>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoStartSchool}
                  onChange={async (e) => {
                    const value = e.target.checked;
                    setAutoStartSchool(value);
                    await saveToRegistry(REG_KEY_AUTO_START_SCHOOL, value.toString());
                  }}
                />
                <span>프로그램 실행 시 학교 위젯 자동 실행</span>
              </label>
            </div>
          </div>
        )}
      </div>



    </div>
  );
};
