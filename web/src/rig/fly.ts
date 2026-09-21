// JevGeni herself. viewBox 260x150. Sits on a stool, foreleg on the joystick.
// Mood drives the LED, the eyes, the wing buzz and the joystick tilt.

import type { SimState } from "../sim/types";

export function renderFly(svg: SVGSVGElement, s: SimState, tMs: number) {
  const mood = s.fly.mood;
  const led =
    mood === "static" ? "#e06c5a" : mood === "startled" ? "#e8b04a" : mood === "tempted" || mood === "yum" ? "#e06c5a" : "#7ee08a";
  const buzz = mood === "startled" || mood === "tempted" || s.claw.phase === "moving";
  const wing = buzz ? Math.sin(tMs / 18) * 10 : Math.sin(tMs / 900) * 1.5;
  const hop = mood === "win" ? Math.abs(Math.sin(tMs / 160)) * -6 : 0;
  const shake = mood === "startled" ? Math.sin(tMs / 25) * 2 : 0;
  const stick = s.claw.phase === "moving" ? (s.claw.targetX < s.claw.x ? -14 : 14) : s.claw.phase === "descending" ? 0 : 0;
  const pressed = s.claw.phase === "descending" || s.claw.phase === "grabbing";
  const ledPulse = 0.6 + 0.4 * Math.abs(Math.sin(tMs / 400));
  const eye = mood === "tempted" || mood === "yum" ? "#ff5a3a" : "#c8402e";

  svg.innerHTML = `
    <defs>
      <radialGradient id="eye" cx="40%" cy="35%">
        <stop offset="0" stop-color="#ff9c8a"/>
        <stop offset="0.6" stop-color="${eye}"/>
        <stop offset="1" stop-color="#6b1a10"/>
      </radialGradient>
      <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e7c46a"/>
        <stop offset="1" stop-color="#a97b2e"/>
      </linearGradient>
      <pattern id="facet" width="4" height="4" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1" fill="rgba(0,0,0,0.25)"/>
      </pattern>
    </defs>

    <!-- stool -->
    <rect x="70" y="112" width="86" height="30" fill="#2a2320" stroke="#8a948f"/>
    <rect x="70" y="108" width="86" height="6" fill="#4a3f38"/>

    <!-- joystick base + red button -->
    <rect x="30" y="126" width="26" height="14" fill="#151a18" stroke="#8a948f"/>
    <g transform="translate(43 126) rotate(${stick})">
      <line x1="0" y1="0" x2="0" y2="-40" stroke="#c9d1cc" stroke-width="3"/>
      <circle cx="0" cy="-44" r="9" fill="#e06c5a"/>
    </g>
    <circle cx="186" cy="${pressed ? 128 : 124}" r="9" fill="#e06c5a"/>
    <rect x="176" y="126" width="20" height="14" fill="#151a18" stroke="#8a948f"/>

    <g transform="translate(${shake} ${hop})">
      <!-- legs -->
      <path d="M 100 100 L 84 118 M 108 102 L 104 120 M 122 102 L 130 120" stroke="#7a5a22" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <!-- foreleg to the joystick knob -->
      <path d="M 88 92 Q 66 88 ${43 + Math.sin((stick * Math.PI) / 180) * 40} ${86 - Math.cos((stick * Math.PI) / 180) * 4}" stroke="#7a5a22" stroke-width="2.5" fill="none" stroke-linecap="round"/>

      <!-- wings -->
      <g transform="translate(112 74)">
        <ellipse rx="44" ry="12" transform="rotate(${-8 + wing}) translate(38 -6)" fill="#9fb0c7" fill-opacity="0.35" stroke="#c9d1cc" stroke-opacity="0.5"/>
        <ellipse rx="40" ry="10" transform="rotate(${4 - wing}) translate(36 2)" fill="#9fb0c7" fill-opacity="0.25" stroke="#c9d1cc" stroke-opacity="0.4"/>
      </g>

      <!-- abdomen (striped) -->
      <g transform="translate(150 92) rotate(12)">
        <ellipse rx="34" ry="17" fill="url(#body)"/>
        <path d="M -8 -16 q 4 16 0 32 M 4 -16 q 4 16 0 32 M 16 -14 q 3 14 0 28" stroke="#3a2a12" stroke-width="4" fill="none"/>
      </g>

      <!-- thorax -->
      <ellipse cx="112" cy="84" rx="21" ry="18" fill="url(#body)"/>
      <path d="M 94 78 q 18 -8 36 0" stroke="#7a5a22" stroke-width="1.5" fill="none"/>

      <!-- implant on the thorax -->
      <rect x="103" y="62" width="18" height="12" rx="2" fill="#151a18" stroke="${led}" stroke-width="1.5"/>
      <line x1="112" y1="62" x2="112" y2="30" stroke="#c9d1cc" stroke-width="1.5"/>
      <circle cx="112" cy="28" r="4" fill="${led}" fill-opacity="${ledPulse}"/>
      <circle cx="112" cy="28" r="8" fill="${led}" fill-opacity="${0.15 * ledPulse}"/>

      <!-- head -->
      <circle cx="84" cy="82" r="16" fill="url(#body)"/>
      <circle cx="78" cy="80" r="11" fill="url(#eye)"/>
      <circle cx="78" cy="80" r="11" fill="url(#facet)"/>
      <path d="M 74 68 q -6 -10 -12 -8 M 80 67 q -2 -10 -8 -12" stroke="#7a5a22" stroke-width="1.5" fill="none"/>
      <!-- proboscis -->
      <path d="M 78 94 q 2 8 -2 12" stroke="#7a5a22" stroke-width="2" fill="none" stroke-linecap="round"/>
    </g>
  `;
}
