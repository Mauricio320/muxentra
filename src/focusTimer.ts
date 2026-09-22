export type FocusPhase = 'work' | 'break';
export type FocusSound = 'subtle' | 'warm' | 'long';

export interface FocusTimerState {
  enabled: boolean;
  running: boolean;
  phase: FocusPhase;
  workMinutes: number;
  breakMinutes: number;
  sound: FocusSound;
  remainingMs: number;
  endsAt: number | null;
}

const MINUTES_MIN = 1;
const MINUTES_MAX = 180;
const minuteMs = (minutes: number): number => minutes * 60_000;
const duration = (state: FocusTimerState, phase: FocusPhase): number =>
  minuteMs(phase === 'work' ? state.workMinutes : state.breakMinutes);

export function validFocusMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MINUTES_MIN && value <= MINUTES_MAX;
}

export function validFocusSound(value: unknown): value is FocusSound {
  return value === 'subtle' || value === 'warm' || value === 'long';
}

export function defaultFocusTimer(): FocusTimerState {
  return {
    enabled: false,
    running: false,
    phase: 'work',
    workMinutes: 20,
    breakMinutes: 5,
    sound: 'subtle',
    remainingMs: minuteMs(20),
    endsAt: null,
  };
}

/** El reloj usa fechas absolutas, así que sigue avanzando si el panel se cierra. */
export function restoreFocusTimer(raw: unknown, now: number): FocusTimerState {
  const base = defaultFocusTimer();
  if (!raw || typeof raw !== 'object') return base;
  const saved = raw as Partial<FocusTimerState>;
  const state: FocusTimerState = {
    ...base,
    workMinutes: validFocusMinutes(saved.workMinutes) ? saved.workMinutes : base.workMinutes,
    breakMinutes: validFocusMinutes(saved.breakMinutes) ? saved.breakMinutes : base.breakMinutes,
    sound: validFocusSound(saved.sound) ? saved.sound : base.sound,
    enabled: saved.enabled === true,
    running: saved.running === true,
    phase: saved.phase === 'break' ? 'break' : 'work',
    endsAt: typeof saved.endsAt === 'number' && Number.isFinite(saved.endsAt) ? saved.endsAt : null,
    remainingMs: typeof saved.remainingMs === 'number' && Number.isFinite(saved.remainingMs)
      ? saved.remainingMs : base.remainingMs,
  };
  if (!state.enabled) return { ...state, running: false, phase: 'work', remainingMs: duration(state, 'work'), endsAt: null };
  if (!state.running || state.endsAt === null) {
    return { ...state, running: false, remainingMs: Math.min(duration(state, state.phase), Math.max(0, state.remainingMs)), endsAt: null };
  }
  return advanceFocusTimer(state, now);
}

export function advanceFocusTimer(state: FocusTimerState, now: number): FocusTimerState {
  if (!state.enabled || !state.running || state.endsAt === null || state.endsAt > now) return state;
  const next: FocusPhase = state.phase === 'work' ? 'break' : 'work';
  const nextMs = duration(state, next);
  const cycleMs = nextMs + duration(state, state.phase);
  const offset = (now - state.endsAt) % cycleMs;
  const phase = offset < nextMs ? next : state.phase;
  const remainingMs = offset < nextMs ? nextMs - offset : cycleMs - offset;
  return { ...state, phase, remainingMs, endsAt: now + remainingMs };
}

/** Solo anuncia un vencimiento reciente, nunca una restauración atrasada. */
export function completedFocusPhase(previous: FocusTimerState, next: FocusTimerState, now: number): FocusPhase | null {
  if (!previous.enabled || !previous.running || previous.endsAt === null) return null;
  if (now < previous.endsAt || now - previous.endsAt > 10_000) return null;
  return next.phase !== previous.phase ? previous.phase : null;
}

export type FocusAction = 'start' | 'pause' | 'resume' | 'skip' | 'stop' | 'configure';

export function changeFocusTimer(
  previous: FocusTimerState,
  action: FocusAction,
  now: number,
  workMinutes?: number,
  breakMinutes?: number,
  sound?: FocusSound,
): FocusTimerState {
  const state = advanceFocusTimer(previous, now);
  if (action === 'configure' || action === 'start') {
    if (!validFocusMinutes(workMinutes) || !validFocusMinutes(breakMinutes)) return state;
    const configured = { ...state, workMinutes, breakMinutes, sound: validFocusSound(sound) ? sound : state.sound };
    if (action === 'configure') {
      return configured.enabled
        ? configured.running ? configured : { ...configured, remainingMs: duration(configured, configured.phase) }
        : { ...configured, remainingMs: duration(configured, 'work') };
    }
    return { ...configured, enabled: true, running: true, phase: 'work', remainingMs: duration(configured, 'work'), endsAt: now + duration(configured, 'work') };
  }
  if (!state.enabled) return state;
  if (action === 'pause' && state.running) {
    return { ...state, running: false, remainingMs: Math.max(0, (state.endsAt ?? now) - now), endsAt: null };
  }
  if (action === 'resume' && !state.running) {
    return { ...state, running: true, endsAt: now + state.remainingMs };
  }
  if (action === 'skip') {
    const phase: FocusPhase = state.phase === 'work' ? 'break' : 'work';
    const remainingMs = duration(state, phase);
    return { ...state, phase, running: true, remainingMs, endsAt: now + remainingMs };
  }
  if (action === 'stop') {
    return { ...state, enabled: false, running: false, phase: 'work', remainingMs: duration(state, 'work'), endsAt: null };
  }
  return state;
}
