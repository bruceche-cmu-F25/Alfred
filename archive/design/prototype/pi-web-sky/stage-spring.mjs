// Only the seven presentation coordinates of this throwaway stage.
// Closed-form, critically damped spring: response .4s, damping ratio 1.
// Retargeting preserves BOTH current position and velocity; no restart from a CSS target.
export function criticalStep(position, velocity, target, dt, response = .4) {
  const omega = 2 * Math.PI / response;
  const offset = position - target, b = velocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  return [target + (offset + b * dt) * decay, (velocity - omega * b * dt) * decay];
}

export function createStageSpring(paint, shouldReduce) {
  let current = null, target = null, velocity = [], frame = 0, last = 0;
  function finish() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!target) return;
    current = [...target]; velocity = target.map(() => 0);
    paint(current);
  }
  function tick(now) {
    frame = 0;
    if (shouldReduce() || document.hidden) { finish(); return; }
    const dt = Math.min((now - last) / 1000, .05); last = now;
    let settled = true;
    for (let i = 0; i < target.length; i++) {
      [current[i], velocity[i]] = criticalStep(current[i], velocity[i], target[i], dt);
      if (Math.abs(current[i] - target[i]) > .06 || Math.abs(velocity[i]) > .6) settled = false;
    }
    if (settled) { finish(); return; }
    paint(current);
    frame = requestAnimationFrame(tick);
  }
  return {
    to(next, immediate = false) {
      const unchanged = target?.every((value, i) => value === next[i]);
      target = [...next];
      if (!current || immediate || shouldReduce() || document.hidden) { finish(); return; }
      if (unchanged) return;
      if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); }
    },
    finish,
  };
}
