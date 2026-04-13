import { Latecomer } from '../types';

interface Props {
  latecomers: Latecomer[];
  loading: boolean;
  onRefresh: () => void;
}

export default function AttendanceTab({ latecomers, loading, onRefresh }: Props) {
  return (
    <div className="attendance-section">
      <div className="controls">
        <button onClick={onRefresh} className="refresh-btn-small">새로고침</button>
      </div>
      {loading ? (
        <div className="loading">로딩 중...</div>
      ) : latecomers.length === 0 ? (
        <div className="empty-message">출결 데이터가 없습니다</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>학생정보</th>
              <th>등교시간</th>
              <th>출결사항</th>
            </tr>
          </thead>
          <tbody>
            {latecomers.map((l, i) => {
              const match = l.student_info.match(/(\d+)번\s+(.+)/);
              const displayInfo = match ? `${match[1]}번\n${match[2]}` : l.student_info;
              return (
                <tr key={i}>
                  <td>{displayInfo}</td>
                  <td>{l.arrival_time}</td>
                  <td>{l.attendance_status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
