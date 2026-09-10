import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { countdownFraction, progressPercent } from '../src/types.ts';

describe('progressPercent', () => {
	it('reports whole percent through a transfer', () => {
		assert.equal(progressPercent({ phase: 'pull', done: 0, total: 40 }), 0);
		assert.equal(progressPercent({ phase: 'pull', done: 10, total: 40 }), 25);
		assert.equal(progressPercent({ phase: 'push', done: 40, total: 40 }), 100);
	});

	it('says nothing rather than dividing by zero', () => {
		assert.equal(progressPercent({ phase: 'push', done: 0, total: 0 }), 0);
	});

	it('cannot read past complete when the count overshoots', () => {
		assert.equal(progressPercent({ phase: 'push', done: 41, total: 40 }), 100);
	});
});

describe('countdownFraction', () => {
	it('drains from full to empty across the window', () => {
		assert.equal(countdownFraction({ remaining: 5000, total: 5000 }), 1);
		assert.equal(countdownFraction({ remaining: 2500, total: 5000 }), 0.5);
		assert.equal(countdownFraction({ remaining: 0, total: 5000 }), 0);
	});

	// A tick can land after the deadline, and a re-arm can be read mid-flight.
	it('clamps a tick that lands outside the window', () => {
		assert.equal(countdownFraction({ remaining: -200, total: 5000 }), 0);
		assert.equal(countdownFraction({ remaining: 6000, total: 5000 }), 1);
	});
});
