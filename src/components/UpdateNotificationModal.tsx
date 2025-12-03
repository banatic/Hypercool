import React from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

interface UpdateNotificationModalProps {
  updateInfo: {
    version: string;
    date: string;
    body: string;
  };
  onClose: () => void;
  onSkip: () => void;
}

export const UpdateNotificationModal: React.FC<UpdateNotificationModalProps> = ({
  updateInfo,
  onClose: _onClose, // 사용되지 않지만 인터페이스 호환성을 위해 유지
  onSkip,
}) => {
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [updateProgress, setUpdateProgress] = React.useState<{ downloaded: number; total: number } | null>(null);

  const handleUpdate = async () => {
    setIsInstalling(true);
    setUpdateProgress({ downloaded: 0, total: 0 });

    try {
      const update = await check();
      if (!update) {
        alert('업데이트를 찾을 수 없습니다.');
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
            break;
          case 'Progress':
            downloaded += event.data.chunkLength ?? 0;
            setUpdateProgress({ downloaded, total: contentLength });
            break;
          case 'Finished':
            setUpdateProgress({ downloaded: contentLength, total: contentLength });
            break;
        }
      });

      await relaunch();
    } catch (error: any) {
      console.error('업데이트 설치 중 오류:', error);
      alert(`업데이트 설치 중 오류가 발생했습니다: ${error?.message || error?.toString() || '알 수 없는 오류'}`);
      setIsInstalling(false);
      setUpdateProgress(null);
    }
  };

  const progressPercent = updateProgress
    ? Math.round((updateProgress.downloaded / updateProgress.total) * 100)
    : 0;

  return (
    <div className="schedule-modal-overlay" onClick={onSkip}>
      <div className="schedule-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px', width: '90%' }}>
        <div className="schedule-inner">
          <div style={{ padding: '24px' }}>
            <h2 style={{ marginTop: 0, marginBottom: '16px', fontSize: '20px', fontWeight: '600' }}>
              🎉 새로운 업데이트가 있습니다
            </h2>
            
            <div style={{ marginBottom: '16px' }}>
              <div style={{ marginBottom: '8px' }}>
                <strong>버전:</strong> {updateInfo.version}
              </div>
              {updateInfo.date && (
                <div style={{ marginBottom: '8px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                  <strong>발행일:</strong> {updateInfo.date}
                </div>
              )}
              {updateInfo.body && (
                <div style={{ 
                  marginTop: '12px', 
                  padding: '12px', 
                  backgroundColor: 'var(--bg-light)', 
                  borderRadius: 'var(--radius)',
                  fontSize: '14px',
                  lineHeight: '1.6',
                  maxHeight: '200px',
                  overflowY: 'auto'
                }}>
                  {updateInfo.body.split('\n').map((line, i) => (
                    <div key={i} style={{ marginBottom: '4px' }}>{line || '\u00A0'}</div>
                  ))}
                </div>
              )}
            </div>

            {isInstalling && updateProgress && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  marginBottom: '8px',
                  fontSize: '14px'
                }}>
                  <span>다운로드 중...</span>
                  <span>{progressPercent}%</span>
                </div>
                <div style={{
                  width: '100%',
                  height: '8px',
                  backgroundColor: 'var(--bg-light)',
                  borderRadius: '4px',
                  overflow: 'hidden'
                }}>
                  <div style={{
                    width: `${progressPercent}%`,
                    height: '100%',
                    backgroundColor: 'var(--primary)',
                    transition: 'width 0.3s ease'
                  }} />
                </div>
                <div style={{ 
                  marginTop: '4px', 
                  fontSize: '12px', 
                  color: 'var(--text-secondary)',
                  textAlign: 'right'
                }}>
                  {((updateProgress.downloaded / 1024 / 1024).toFixed(2))} MB / {((updateProgress.total / 1024 / 1024).toFixed(2))} MB
                </div>
              </div>
            )}

            <div className="row" style={{ marginTop: '24px' }}>
              <button 
                onClick={handleUpdate} 
                disabled={isInstalling}
                style={{
                  flex: 1,
                  opacity: isInstalling ? 0.6 : 1,
                  cursor: isInstalling ? 'not-allowed' : 'pointer'
                }}
              >
                {isInstalling ? '업데이트 중...' : '업데이트하기'}
              </button>
              <button 
                onClick={onSkip} 
                disabled={isInstalling}
                style={{
                  flex: 1,
                  opacity: isInstalling ? 0.6 : 1,
                  cursor: isInstalling ? 'not-allowed' : 'pointer',
                  backgroundColor: 'var(--bg-light)',
                  color: 'var(--text)'
                }}
              >
                이번 업데이트 넘어가기
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

