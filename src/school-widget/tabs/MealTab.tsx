import { MealInfo } from '../types';

interface Props {
  mealInfo: MealInfo;
  loading: boolean;
}

export default function MealTab({ mealInfo, loading }: Props) {
  return (
    <div className="meal-section">
      <div className="section-header">
        <h2>오늘의 급식</h2>
        <span className="date">{new Date().toLocaleDateString()}</span>
      </div>
      {loading ? (
        <div className="loading">로딩 중...</div>
      ) : (
        <div className="meal-items-container">
          <div className="meal-item">
            <div className="meal-type">중식</div>
            <div className="meal-menu">{mealInfo.lunch}</div>
          </div>
          <div className="meal-item">
            <div className="meal-type">석식</div>
            <div className="meal-menu">{mealInfo.dinner}</div>
          </div>
        </div>
      )}
    </div>
  );
}
