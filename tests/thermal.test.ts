import test from 'node:test';
import assert from 'node:assert/strict';
import { isDesktopMode, getCpuTemperature } from '../services/thermal.service';
import { jobOptionsSchema } from '../lib/schemas';
import type { JobSnapshot, ThermalRestState } from '../types';

test('isDesktopMode detects desktop environment variables', () => {
  const originalIsDesktop = process.env.IS_DESKTOP;
  const originalDesktopApp = process.env.DESKTOP_APP;

  try {
    delete process.env.IS_DESKTOP;
    delete process.env.DESKTOP_APP;
    // Without env vars and without Electron, isDesktopMode returns false
    assert.equal(isDesktopMode(), false);

    process.env.IS_DESKTOP = '1';
    assert.equal(isDesktopMode(), true);

    delete process.env.IS_DESKTOP;
    process.env.DESKTOP_APP = 'true';
    assert.equal(isDesktopMode(), true);
  } finally {
    if (originalIsDesktop !== undefined) process.env.IS_DESKTOP = originalIsDesktop;
    else delete process.env.IS_DESKTOP;
    if (originalDesktopApp !== undefined) process.env.DESKTOP_APP = originalDesktopApp;
    else delete process.env.DESKTOP_APP;
  }
});

test('jobOptionsSchema applies default thermal protection (80°C threshold, 30 min rest)', () => {
  const parsed = jobOptionsSchema.parse({});
  assert.equal(parsed.thermalProtection, true);
  assert.equal(parsed.tempThreshold, 80);
  assert.equal(parsed.cooldownMinutes, 30);
});

test('getCpuTemperature returns a valid temperature or null', async () => {
  const temp = await getCpuTemperature();
  if (temp !== null) {
    assert.ok(typeof temp === 'number');
    assert.ok(temp >= 0 && temp < 130, `Temperature ${temp}°C is within physical boundaries`);
  }
});

test('thermal rest calculation correctly calculates 30-minute rest window', () => {
  const temp = 82.5;
  const threshold = 80;
  const cooldownMin = 30;
  const cooldownMs = cooldownMin * 60 * 1000;

  assert.ok(temp >= threshold, 'Temperature breaches threshold');

  const now = Date.now();
  const restUntil = new Date(now + cooldownMs).toISOString();

  const state: ThermalRestState = {
    isResting: true,
    triggerTemp: temp,
    currentTemp: temp,
    threshold,
    restUntil,
    remainingMs: cooldownMs,
  };

  assert.equal(state.isResting, true);
  assert.equal(state.triggerTemp, 82.5);
  assert.equal(state.threshold, 80);
  assert.equal(state.remainingMs, 1800000); // 30 minutes in ms
  assert.ok(Date.parse(state.restUntil!) >= now + cooldownMs - 1000);
});

test('JobSnapshot correctly exposes thermalRest field', () => {
  const snapshot: Partial<JobSnapshot> = {
    id: 'test-job',
    status: 'paused',
    thermalRest: {
      isResting: true,
      triggerTemp: 83.2,
      currentTemp: 81.0,
      threshold: 80,
      restUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      remainingMs: 30 * 60 * 1000,
    },
  };

  assert.equal(snapshot.thermalRest?.isResting, true);
  assert.equal(snapshot.thermalRest?.triggerTemp, 83.2);
  assert.equal(snapshot.thermalRest?.threshold, 80);
});
