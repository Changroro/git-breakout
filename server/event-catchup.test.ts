import { describe, expect, it, vi } from 'vitest';
import { collectEventHour, runEventCatchup, selectMissingEventHours } from './event-catchup.ts';

describe('event hour recovery', () => {
  it('finds gaps independently of metadata cadence and skips completed zero hours', () => {
    expect(selectMissingEventHours('2026-09-12T10:30:00Z', ['2026-09-12T08:00:00Z'], 3, 6)).toEqual([
      '2026-09-12T07:00:00.000Z', '2026-09-12T06:00:00.000Z', '2026-09-12T05:00:00.000Z',
    ]);
  });

  it('records a successfully parsed hour with no relevant events', async () => {
    const completeEventHour = vi.fn().mockResolvedValue(undefined);
    await collectEventHour('2026-09-12T08:00:00.000Z', 1000, { completeEventHour }, async () => ({ buckets: [], lineCount: 2, rejectedLines: [] }));
    expect(completeEventHour).toHaveBeenCalledWith('2026-09-12T08:00:00.000Z', [], { sourceRepositoryCount: 0, lineCount: 2, rejectedLineCount: 0 });
  });

  it('leaves failed hours incomplete and continues bounded recovery', async () => {
    const processed: string[] = [];
    await expect(runEventCatchup(['2026-09-12T08:00:00.000Z', '2026-09-12T07:00:00.000Z'], async hour => {
      processed.push(hour);
      if (hour.includes('08:')) throw new Error('injected archive failure');
    })).rejects.toThrow('1 event hour failed');
    expect(processed).toHaveLength(2);
  });

  it('limits catchup and does no work when the whole recovery interval is complete', () => {
    expect(() => selectMissingEventHours('2026-09-12T10:00:00Z', [], 7)).toThrow('between 1 and 6');
    expect(selectMissingEventHours('2026-09-12T10:00:00Z', ['2026-09-12T08:00:00Z', '2026-09-12T07:00:00Z'], 2, 2)).toEqual([]);
  });

  it('does not mark an archive download failure completed', async () => {
    const completeEventHour = vi.fn();
    await expect(collectEventHour('2026-09-12T08:00:00.000Z', 1000, { completeEventHour }, async () => { throw new Error('truncated gzip'); })).rejects.toThrow('truncated gzip');
    expect(completeEventHour).not.toHaveBeenCalled();
  });
});
