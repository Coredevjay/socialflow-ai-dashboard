import { eventBus, resetEventBus, JobProgressEvent } from '../eventBus';

describe('eventBus', () => {
  afterEach(() => {
    resetEventBus();
  });

  const sampleEvent: JobProgressEvent = {
    jobId: 'job-1',
    userId: 'user-1',
    type: 'ai_generation',
    status: 'processing',
    progress: 50,
  };

  it('delivers job progress events to listeners scoped to the user', () => {
    const listener = jest.fn();
    eventBus.onUserJob('user-1', listener);

    eventBus.emitJobProgress(sampleEvent);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining(sampleEvent));
  });

  it('does not deliver events to a different user', () => {
    const listener = jest.fn();
    eventBus.onUserJob('user-2', listener);

    eventBus.emitJobProgress(sampleEvent);

    expect(listener).not.toHaveBeenCalled();
  });

  it('also emits on the wildcard channel for monitoring', () => {
    const wildcardListener = jest.fn();
    eventBus.on('job:*', wildcardListener);

    eventBus.emitJobProgress(sampleEvent);

    expect(wildcardListener).toHaveBeenCalledWith(expect.objectContaining(sampleEvent));
  });

  it('stops delivering events after offUserJob removes the listener', () => {
    const listener = jest.fn();
    eventBus.onUserJob('user-1', listener);
    eventBus.offUserJob('user-1', listener);

    eventBus.emitJobProgress(sampleEvent);

    expect(listener).not.toHaveBeenCalled();
  });

  it('reset removes all listeners', () => {
    const listener = jest.fn();
    eventBus.onUserJob('user-1', listener);

    resetEventBus();
    eventBus.emitJobProgress(sampleEvent);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('eventBus sequencing and replay', () => {
  afterEach(() => resetEventBus());

  const ev = (progress: number): JobProgressEvent => ({
    jobId: 'job-1',
    userId: 'user-1',
    type: 'ai_generation',
    status: 'processing',
    progress,
  });

  it('assigns monotonically increasing per-user seq even for repeated progress', () => {
    const seen: number[] = [];
    eventBus.onUserJob('user-1', (e) => seen.push(e.seq as number));
    eventBus.emitJobProgress(ev(50));
    eventBus.emitJobProgress(ev(50));
    expect(seen).toEqual([1, 2]);
  });

  it('replays only events after Last-Event-ID', async () => {
    eventBus.emitJobProgress(ev(10));
    eventBus.emitJobProgress(ev(20));
    eventBus.emitJobProgress(ev(30));
    const missed = await eventBus.getMissedEvents('user-1', 1);
    expect(missed.map((e) => e.progress)).toEqual([20, 30]);
  });
});
