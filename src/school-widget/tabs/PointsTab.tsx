import { PointStatus } from '../types';

interface Props {
  points: PointStatus[];
  loading: boolean;
  onRefresh: () => void;
}

export default function PointsTab({ points, loading, onRefresh }: Props) {
  return (
    <div className="points-section">
      <div className="controls">
        <button onClick={onRefresh} className="refresh-btn-small">새로고침</button>
      </div>
      {loading ? (
        <div className="loading">로딩 중...</div>
      ) : points.length === 0 ? (
        <div className="empty-message">상벌점 데이터가 없습니다</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>학생정보</th>
              <th>상점</th>
              <th>벌점</th>
              <th>상쇄</th>
              <th>총점</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => {
              const match = p.student_info.match(/(\d+)번\s+(.+)/);
              const displayInfo = match ? `${match[1]}번 ${match[2]}` : p.student_info;
              return (
                <tr key={i}>
                  <td>{displayInfo}</td>
                  <td className="reward">{p.reward}</td>
                  <td className="penalty">{p.penalty}</td>
                  <td>{p.offset}</td>
                  <td className="total">{p.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
