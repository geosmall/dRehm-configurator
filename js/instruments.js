/**
 * @file instruments.js
 * @brief Artificial-horizon (attitude) and heading flight indicators.
 *
 * Vanilla-JS port of the attitude + heading instruments from the GPLv3
 * jQuery-Flight-Indicators plugin by Sébastien Matton (seb_matton@hotmail.com),
 * https://github.com/sebmatton/jQuery-Flight-Indicators. Pure layered SVG +
 * CSS transforms; no jQuery dependency. Layout rules live in css/style.css.
 */

const IMG_DIR = 'images/flightindicators/';
const PITCH_BOUND = 30;   // degrees the horizon ball travels before clamping

function img(name, cls) {
  return `<img src="${IMG_DIR}${name}" class="${cls}" alt="" />`;
}

/**
 * Build an instrument inside `container` and return its setter API.
 * @param {HTMLElement} container  host element
 * @param {'attitude'|'heading'} type
 * @param {{size?:number, showBox?:boolean}} [opts]
 */
export function createInstrument(container, type, opts = {}) {
  const size = opts.size ?? 90;
  const showBox = opts.showBox ?? false;

  let html;
  if (type === 'heading') {
    html =
      `<div class="instrument heading">` +
        img('fi_box.svg', 'background box') +
        `<div class="heading box">${img('heading_yaw.svg', 'box')}</div>` +
        `<div class="mechanics box">` +
          img('heading_mechanics.svg', 'box') +
          img('fi_circle.svg', 'box') +
        `</div>` +
      `</div>`;
  } else {
    // attitude (artificial horizon)
    html =
      `<div class="instrument attitude">` +
        img('fi_box.svg', 'background box') +
        `<div class="roll box">` +
          img('horizon_back.svg', 'box') +
          `<div class="pitch box">${img('horizon_ball.svg', 'box')}</div>` +
          img('horizon_circle.svg', 'box') +
        `</div>` +
        `<div class="mechanics box">` +
          img('horizon_mechanics.svg', 'box') +
          img('fi_circle.svg', 'box') +
        `</div>` +
      `</div>`;
  }

  container.innerHTML = html;
  const instrument = container.querySelector('div.instrument');
  instrument.style.width = `${size}px`;
  instrument.style.height = `${size}px`;

  const bg = container.querySelector('img.box.background');
  if (bg) bg.style.display = showBox ? '' : 'none';

  const rollEl = container.querySelector('div.roll');
  const pitchEl = container.querySelector('div.roll div.pitch');
  const headingEl = container.querySelector('div.instrument.heading div.heading');

  return {
    setRoll(roll) {
      if (rollEl) rollEl.style.transform = `rotate(${-roll}deg)`;
    },
    setPitch(pitch) {
      if (!pitchEl) return;
      const p = Math.max(-PITCH_BOUND, Math.min(PITCH_BOUND, pitch));
      pitchEl.style.top = `${-p * 0.7}%`;
    },
    setHeading(heading) {
      if (headingEl) headingEl.style.transform = `rotate(${-heading}deg)`;
    },
  };
}
