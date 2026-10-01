// Draws a simple stylised mannequin from pixel landmarks (landing-page demo).
import { LM } from './body.js';

const LIMBS = [
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  [LM.LEFT_HIP, LM.LEFT_KNEE], [LM.LEFT_KNEE, LM.LEFT_ANKLE],
  [LM.RIGHT_HIP, LM.RIGHT_KNEE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
];

export function drawMannequin(ctx, pts, { skin = '#e9c3a6', shade = '#d4a687' } = {}) {
  const sw = Math.hypot(pts[11].x - pts[12].x, pts[11].y - pts[12].y);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.strokeStyle = shade;
  ctx.lineWidth = sw * 0.24;
  for (const [a, b] of LIMBS) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  }

  // Torso.
  const ls = pts[11];
  const rs = pts[12];
  const lh = pts[23];
  const rh = pts[24];
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(rs.x, rs.y);
  ctx.lineTo(ls.x, ls.y);
  ctx.quadraticCurveTo(ls.x + sw * 0.02, (ls.y + lh.y) / 2, lh.x + sw * 0.08, lh.y);
  ctx.lineTo(rh.x - sw * 0.08, rh.y);
  ctx.quadraticCurveTo(rs.x - sw * 0.02, (rs.y + rh.y) / 2, rs.x, rs.y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = skin;
  ctx.lineWidth = sw * 0.22;
  ctx.stroke();

  // Neck and head.
  const nose = pts[LM.NOSE];
  const neckTop = { x: nose.x, y: nose.y + sw * 0.25 };
  const neckBase = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  ctx.lineWidth = sw * 0.2;
  ctx.beginPath();
  ctx.moveTo(neckBase.x, neckBase.y);
  ctx.lineTo(neckTop.x, neckTop.y);
  ctx.stroke();
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(nose.x, nose.y - sw * 0.06, sw * 0.24, sw * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
