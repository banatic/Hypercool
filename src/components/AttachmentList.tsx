import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface AttachmentListProps {
  filePaths: string[];
}

export const AttachmentList: React.FC<AttachmentListProps> = ({ filePaths }) => {
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const [fileStatuses, setFileStatuses] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // 다운로드 경로 가져오기
    const loadDownloadPath = async () => {
      try {
        const path = await invoke<string | null>('get_download_path');
        setDownloadPath(path);
      } catch (error) {
        console.error('다운로드 경로 로드 실패:', error);
      }
    };

    loadDownloadPath();
  }, []);

  useEffect(() => {
    // 각 파일의 존재 여부 확인
    const checkFiles = async () => {
      if (!downloadPath || filePaths.length === 0) return;

      const statuses: Record<string, boolean> = {};
      for (const fileName of filePaths) {
        try {
          const fullPath = `${downloadPath}\\${fileName}`;
          const exists = await invoke<boolean>('check_file_exists', { filePath: fullPath });
          statuses[fileName] = exists;
        } catch (error) {
          console.error(`파일 확인 실패: ${fileName}`, error);
          statuses[fileName] = false;
        }
      }
      setFileStatuses(statuses);
    };

    checkFiles();
  }, [downloadPath, filePaths]);

  const handleFileClick = async (fileName: string) => {
    if (!downloadPath) return;

    try {
      const fullPath = `${downloadPath}\\${fileName}`;
      await invoke('open_file', { filePath: fullPath });
    } catch (error) {
      console.error('파일 열기 실패:', error);
      // alert('파일을 열 수 없습니다.'); // Removed
    }
  };

  if (filePaths.length === 0) {
    return null;
  }

  return (
    <div className="attachment-list" style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: '500' }}>
        첨부파일
      </div>
      {filePaths.map((fileName, index) => {
        const exists = fileStatuses[fileName] ?? false;
        return (
          <div
            key={index}
            onClick={() => handleFileClick(fileName)}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '6px 8px',
              marginBottom: '4px',
              borderRadius: '4px',
              cursor: 'pointer',
              backgroundColor: exists ? 'rgba(102, 126, 234, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = exists 
                ? 'rgba(102, 126, 234, 0.2)' 
                : 'rgba(239, 68, 68, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = exists 
                ? 'rgba(102, 126, 234, 0.1)' 
                : 'rgba(239, 68, 68, 0.1)';
            }}
          >
            <span style={{ fontSize: '12px', marginRight: '8px' }}>📎</span>
            <span style={{ fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#000000' }}>
              {fileName}
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '2px 6px',
                borderRadius: '3px',
                backgroundColor: exists ? 'var(--success)' : 'var(--danger)',
                color: 'white',
                fontWeight: '500',
              }}
            >
              {exists ? '다운됨' : '다운안됨'}
            </span>
          </div>
        );
      })}
    </div>
  );
};

