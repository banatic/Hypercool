import { describe, it, expect, vi, afterEach } from 'vitest';
import { getHoliday, refreshHolidays } from './holidays';

afterEach(() => vi.unstubAllGlobals());

describe('getHoliday', () => {
  it('returns bundled holiday names by local date', () => {
    expect(getHoliday(new Date(2026, 6, 17))).toBe('제헌절');
    expect(getHoliday(new Date(2026, 9, 5))).toBe('대체공휴일');
    expect(getHoliday(new Date(2026, 9, 15))).toBeUndefined();
  });

  it('applies remote holidays.json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ holidays: { '2028-01-01': '신정', bad: 1 } }),
    }));
    expect(await refreshHolidays()).toBe(true);
    expect(getHoliday(new Date(2028, 0, 1))).toBe('신정');
  });

  it('keeps current data when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await refreshHolidays()).toBe(false);
    expect(getHoliday(new Date(2028, 0, 1))).toBe('신정');
  });
});
