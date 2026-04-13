import { Tab, ALL_TABS } from './types';

interface Props {
  activeTab: Tab;
  enabledTabs: Tab[];
  onTabChange: (tab: Tab) => void;
}

export default function TabBar({ activeTab, enabledTabs, onTabChange }: Props) {
  const visibleTabs = ALL_TABS.filter(t => t.id === 'settings' || enabledTabs.includes(t.id));

  return (
    <div className="tab-bar">
      {visibleTabs.map(({ id, label }) => (
        <button
          key={id}
          className={activeTab === id ? 'tab active' : 'tab'}
          onClick={() => onTabChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
