// Draws a stylised mannequin from a synthetic body's exact geometry (landing
// page demo), so the figure matches the outline the garment is fitted to.

export function drawSyntheticBody(ctx, truth, { skin = '#e9c3a6', shade = '#d9b092' } = {}) {
  const { sw, T } = truth;
  const seg = (a, b, width, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const leg of Object.values(truth.legs)) {
    seg(leg.hip, leg.knee, truth.legRadii.thigh * 1.8, shade);
    seg(leg.knee, leg.ankle, truth.legRadii.knee * 1.9, shade);
  }
  // Neck and head.
  const n0 = truth.toImage(-truth.neckHalf, -0.36 * T);
  const n1 = truth.toImage(truth.neckHalf, -0.36 * T);
  const n2 = truth.toImage(truth.neckHalf, truth.neckBaseV + 2);
  const n3 = truth.toImage(-truth.neckHalf, truth.neckBaseV + 2);
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(n0.x, n0.y);
  ctx.lineTo(n1.x, n1.y);
  ctx.lineTo(n2.x, n2.y);
  ctx.lineTo(n3.x, n3.y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(truth.head.center.x, truth.head.center.y, truth.head.ru, truth.head.rv, truth.head.angle, 0, Math.PI * 2);
  ctx.fill();
  // Torso outline from the half-width profile.
  ctx.fillStyle = skin;
  ctx.beginPath();
  const step = T / 40;
  let first = true;
  for (let v = -0.08 * T; v <= 1.2 * T; v += step) {
    const p = truth.edgeAt(v, 'imageLeft');
    if (first) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
    first = false;
  }
  for (let v = 1.2 * T; v >= -0.08 * T; v -= step) {
    const p = truth.edgeAt(v, 'imageRight');
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fill();
  // Arms in front of the torso.
  for (const arm of Object.values(truth.arms)) {
    seg(arm.joint, arm.elbow, truth.rU * 2, skin);
    seg(arm.elbow, arm.wrist, truth.rF * 1.9, skin);
    seg(arm.wrist, arm.hand, sw * 0.15, shade);
  }
  ctx.restore();
}
