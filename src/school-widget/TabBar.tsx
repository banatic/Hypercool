import { getCurrentWindow } from '@tauri-apps/api/window';
import { Tab, ALL_TABS } from './types';

interface Props {
  activeTab: Tab;
  enabledTabs: Tab[];
  onTabChange: (tab: Tab) => void;
  stockUnlocked?: boolean;
  onUnlockStock?: () => void;
}

export default function TabBar({ activeTab, enabledTabs, onTabChange, stockUnlocked, onUnlockStock }: Props) {
  const baseTabs = ALL_TABS.filter(t => t.id === 'settings' || enabledTabs.includes(t.id));

  // Inject stock tab before settings when unlocked
  const visibleTabs = stockUnlocked
    ? [
        ...baseTabs.filter(t => t.id !== 'settings'),
        { id: 'stock' as Tab, label: '주식' },
        baseTabs.find(t => t.id === 'settings')!,
      ].filter(Boolean)
    : baseTabs;

  const handleMouseDown = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (me: MouseEvent) => {
      if (Math.abs(me.clientX - startX) > 3 || Math.abs(me.clientY - startY) > 3) {
        cleanup();
        getCurrentWindow().startDragging();
      }
    };
    const onUp = () => cleanup();
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div className="tab-bar" onMouseDown={handleMouseDown}>
      {visibleTabs.map(({ id, label }) => (
        <button
          key={id}
          className={activeTab === id ? 'tab active' : 'tab'}
          onClick={(e) => {
            // Easter egg: Shift+click on settings tab unlocks stock tab
            if (id === 'settings' && e.shiftKey && !stockUnlocked && onUnlockStock) {
              onUnlockStock();
              return;
            }
            onTabChange(id);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
