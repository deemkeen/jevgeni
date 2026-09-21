// The claw machine, side view. viewBox 1000x400. Pure function of SimState.

import { ANTENNA_X } from "../sim/sim";
import type { ItemKind, SimState } from "../sim/types";

const EMOJI: Record<ItemKind, string> = { dung: "💩", banana: "🍌", apple: "🍎", wine: "🍷", cheese: "🧀" };
const LABEL: Record<ItemKind, string> = { dung: "DUNG", banana: "BANANA", apple: "APPLE", wine: "WINE", cheese: "CHEESE" };

const W = 1000;
const RAIL_Y = 28;
const FLOOR_Y = 330;
const CLAW_TOP = 70;
const CLAW_BOTTOM = FLOOR_Y - 46;
const PAD = 60;

const px = (x: number) => PAD + x * (W - 2 * PAD);

export function renderClaw(svg: SVGSVGElement, s: SimState, camClock: string) {
  const c = s.claw;
  const cx = px(c.x);
  const cy = CLAW_TOP + c.y * (CLAW_BOTTOM - CLAW_TOP);
  const open = c.phase === "descending" ? 1 : c.phase === "grabbing" || c.phase === "rising" ? 0.15 : 0.6;
  const ax = px(ANTENNA_X);
  const sig = s.fly.signal;

  const items = s.items
    .map(
      (i) => `
      <g transform="translate(${px(i.x)} ${FLOOR_Y})">
        <text y="-14" text-anchor="middle" font-size="44">${EMOJI[i.kind]}</text>
        <text y="8" text-anchor="middle" font-size="9" letter-spacing="1.5" fill="#6f7d76" font-family="JetBrains Mono, monospace">${LABEL[i.kind]}</text>
      </g>`,
    )
    .join("");

  const held = c.holding
    ? `<text x="${cx}" y="${cy + 46}" text-anchor="middle" font-size="40">${EMOJI[c.holding.kind]}</text>`
    : "";

  const prongL = `M ${cx - 4} ${cy} q ${-14 * open - 4} 14 ${-8 * open - 4} 30`;
  const prongR = `M ${cx + 4} ${cy} q ${14 * open + 4} 14 ${8 * open + 4} 30`;

  svg.innerHTML = `
    <defs>
      <pattern id="hazard" width="24" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
        <rect width="12" height="12" fill="#d9a441"/>
        <rect x="12" width="12" height="12" fill="#151a18"/>
      </pattern>
      <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="1" fill="rgba(120,200,150,0.06)"/>
      </pattern>
      <radialGradient id="sigring" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#7ee08a" stop-opacity="0.18"/>
        <stop offset="1" stop-color="#7ee08a" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="400" fill="url(#scan)"/>
    <rect x="0" y="0" width="${W}" height="14" fill="url(#hazard)"/>
    <rect x="0" y="${RAIL_Y}" width="${W}" height="2" fill="#5a655f"/>

    <!-- signal field around the antenna -->
    <ellipse cx="${ax}" cy="${RAIL_Y + 30}" rx="${120 + 300 * sig}" ry="${40 + 90 * sig}" fill="url(#sigring)"/>
    <ellipse cx="${ax}" cy="${RAIL_Y + 30}" rx="${120 + 300 * sig}" ry="${40 + 90 * sig}" fill="none" stroke="#7ee08a" stroke-opacity="0.35" stroke-dasharray="4 6"/>
    <line x1="${ax}" y1="${RAIL_Y + 40}" x2="${cx}" y2="${cy - 6}" stroke="#7ee08a" stroke-opacity="${0.15 + 0.6 * sig}" stroke-dasharray="3 5"/>

    <!-- antenna -->
    <line x1="${ax}" y1="${RAIL_Y}" x2="${ax}" y2="${RAIL_Y + 40}" stroke="#9aa8a0" stroke-width="2"/>
    <circle cx="${ax}" cy="${RAIL_Y + 40}" r="4" fill="#7ee08a"/>
    <rect x="${ax - 40}" y="${RAIL_Y + 4}" width="80" height="12" fill="#151a18" stroke="#5a655f"/>
    <text x="${ax}" y="${RAIL_Y + 13}" text-anchor="middle" font-size="8" letter-spacing="1.6" fill="#c9d1cc" font-family="JetBrains Mono, monospace">RX ANTENNA</text>

    <!-- trolley + cable + claw -->
    <rect x="${cx - 16}" y="${RAIL_Y - 6}" width="32" height="14" fill="#8a948f" stroke="#c9d1cc"/>
    <line x1="${cx}" y1="${RAIL_Y + 8}" x2="${cx}" y2="${cy}" stroke="#c9d1cc" stroke-width="1.5"/>
    <circle cx="${cx}" cy="${cy}" r="7" fill="#151a18" stroke="#e6ece8" stroke-width="2"/>
    <path d="${prongL}" fill="none" stroke="#e6ece8" stroke-width="3" stroke-linecap="round"/>
    <path d="${prongR}" fill="none" stroke="#e6ece8" stroke-width="3" stroke-linecap="round"/>
    ${held}

    <!-- floor + items -->
    <line x1="0" y1="${FLOOR_Y + 14}" x2="${W}" y2="${FLOOR_Y + 14}" stroke="#3a4540"/>
    <rect x="0" y="${FLOOR_Y + 16}" width="${W}" height="8" fill="url(#hazard)" opacity="0.5"/>
    ${items}

    <!-- cam overlay -->
    <text x="${W - 14}" y="${RAIL_Y + 34}" text-anchor="end" font-size="9" letter-spacing="1.5" fill="#8a948f" font-family="JetBrains Mono, monospace">CAM 02 · REC <tspan fill="#e06c5a">●</tspan></text>
    <text x="${W - 14}" y="${RAIL_Y + 48}" text-anchor="end" font-size="9" letter-spacing="1.5" fill="#8a948f" font-family="JetBrains Mono, monospace">${camClock}</text>
  `;
}
