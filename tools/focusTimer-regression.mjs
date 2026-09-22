import assert from 'node:assert/strict';
import {
  advanceFocusTimer,
  changeFocusTimer,
  completedFocusPhase,
  defaultFocusTimer,
  restoreFocusTimer,
  validFocusSound,
} from '../src/focusTimer.ts';

const t0 = 1_000_000;
const minute = 60_000;
const initial = defaultFocusTimer();
assert.equal(initial.workMinutes, 20);
assert.equal(initial.breakMinutes, 5);
assert.equal(initial.enabled, false);
assert.equal(initial.sound, 'subtle');
assert.equal(validFocusSound('warm'), true);
assert.equal(validFocusSound('unknown'), false);

const started = changeFocusTimer(initial, 'start', t0, 20, 5);
assert.equal(started.phase, 'work');
assert.equal(started.endsAt, t0 + 20 * minute);
assert.equal(advanceFocusTimer(started, t0 + 20 * minute - 1).phase, 'work');
assert.equal(restoreFocusTimer({ ...started, sound: 'unknown' }, t0).sound, 'subtle');

const withWarmSound = changeFocusTimer(initial, 'start', t0, 20, 5, 'warm');
assert.equal(withWarmSound.sound, 'warm');
assert.equal(advanceFocusTimer(withWarmSound, t0 + 20 * minute).sound, 'warm');

const resting = advanceFocusTimer(started, t0 + 20 * minute);
assert.equal(resting.phase, 'break');
assert.equal(resting.endsAt, t0 + 25 * minute);
assert.equal(completedFocusPhase(started, resting, t0 + 20 * minute), 'work');
assert.equal(completedFocusPhase(started, resting, t0 + 20 * minute + 11_000), null);
assert.equal(completedFocusPhase(resting, resting, t0 + 20 * minute), null);
assert.equal(completedFocusPhase(resting, advanceFocusTimer(resting, t0 + 25 * minute), t0 + 25 * minute), 'break');
assert.equal(advanceFocusTimer(started, t0 + 25 * minute).phase, 'work');
assert.equal(advanceFocusTimer(started, t0 + 75 * minute + 2 * minute).phase, 'work');
assert.equal(restoreFocusTimer(started, t0 + 3 * 24 * 60 * minute).enabled, true);

const changedWhileRunning = changeFocusTimer(started, 'configure', t0 + 2 * minute, 30, 7);
assert.equal(changedWhileRunning.endsAt, started.endsAt);
assert.equal(advanceFocusTimer(changedWhileRunning, t0 + 20 * minute).endsAt, t0 + 27 * minute);

const paused = changeFocusTimer(started, 'pause', t0 + 4 * minute);
assert.equal(paused.running, false);
assert.equal(paused.remainingMs, 16 * minute);
assert.equal(restoreFocusTimer(paused, t0 + 40 * minute).remainingMs, 16 * minute);
const resumed = changeFocusTimer(paused, 'resume', t0 + 40 * minute);
assert.equal(resumed.endsAt, t0 + 56 * minute);

const configured = changeFocusTimer(paused, 'configure', t0 + 4 * minute, 30, 7);
assert.equal(configured.remainingMs, 30 * minute);
assert.equal(configured.breakMinutes, 7);
assert.equal(changeFocusTimer(paused, 'configure', t0 + 4 * minute, 30, 7, 'long').sound, 'long');
assert.equal(changeFocusTimer(paused, 'configure', t0, 0, 5), paused);
assert.equal(changeFocusTimer(paused, 'configure', t0, 20.5, 5), paused);

const skipped = changeFocusTimer(paused, 'skip', t0 + 4 * minute);
assert.equal(skipped.phase, 'break');
assert.equal(skipped.endsAt, t0 + 9 * minute);
assert.equal(completedFocusPhase(paused, skipped, t0 + 4 * minute), null);
assert.equal(completedFocusPhase(started, changeFocusTimer(started, 'skip', t0 + 4 * minute), t0 + 4 * minute), null);
assert.equal(changeFocusTimer(skipped, 'stop', t0).enabled, false);
assert.equal(changeFocusTimer(configured, 'stop', t0).workMinutes, 30);
assert.equal(changeFocusTimer(withWarmSound, 'stop', t0).sound, 'warm');
assert.equal(restoreFocusTimer(started, t0 + 20 * minute).phase, 'break');

console.log('Focus timer: transiciones, pausa, configuración y restauración correctas.');
