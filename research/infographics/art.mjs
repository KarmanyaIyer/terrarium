// Hand-made SVG art. Each function returns markup for a 1080x600 viewBox; the top 40px are cropped by the page.

const star4 = (x, y, r, fill) => `<path transform="translate(${x} ${y})" d="M0 ${-r} C ${r * 0.12} ${-r * 0.3} ${r * 0.3} ${-r * 0.12} ${r} 0 C ${r * 0.3} ${r * 0.12} ${r * 0.12} ${r * 0.3} 0 ${r} C ${-r * 0.12} ${r * 0.3} ${-r * 0.3} ${r * 0.12} ${-r} 0 C ${-r * 0.3} ${-r * 0.12} ${-r * 0.12} ${-r * 0.3} 0 ${-r} Z" fill="${fill}"/>`;

export function eiffelArt() {
  const sky = '#8cc8ea';
  const iron = '#33272a';
  const steel = '#3f4a5c';
  // Tower drawn around x=0, top at y=0, feet at y=500.
  const left = `M0 0 L3 44 L8 64 L17 64 L17 76 L11 76 C14 150 22 205 38 246 L52 246 L52 260 L42 260 C50 298 62 322 80 346 L100 346 L100 364 L84 364 C102 412 128 462 164 500 L100 500 C96 452 62 408 0 404`;
  const right = `C-62 408 -96 452 -100 500 L-164 500 C-128 462 -102 412 -84 364 L-100 364 L-100 346 L-80 346 C-62 322 -50 298 -42 260 L-52 260 L-52 246 L-38 246 C-22 205 -14 150 -11 76 L-17 76 L-17 64 L-8 64 L-3 44 Z`;
  const shape = left + ' ' + right;
  let lattice = '';
  for (let i = -40; i < 40; i++) {
    const o = i * 21;
    lattice += `<path d="M${o - 300} 620 L${o + 300} 20" /><path d="M${o - 300} 20 L${o + 300} 620" />`;
  }
  let gingham = '';
  const size = 44;
  for (let x = 0; x < 1080; x += size) {
    if ((x / size) % 2 === 0) gingham += `<rect x="${x}" y="500" width="${size}" height="100" fill="#d7372f" opacity=".62"/>`;
  }
  for (let y = 500; y < 600; y += size) {
    if (((y - 500) / size) % 2 === 0) gingham += `<rect x="0" y="${y}" width="1080" height="${size}" fill="#d7372f" opacity=".62"/>`;
  }
  return `
  <rect width="1080" height="600" fill="${sky}"/>
  <g fill="#e9f6fd">
    <path d="M36 452 a38 38 0 0 1 62 -30 a52 52 0 0 1 96 6 a34 34 0 0 1 34 24 Z"/>
    <path d="M866 186 a30 30 0 0 1 50 -24 a42 42 0 0 1 78 4 a28 28 0 0 1 30 20 Z"/>
    <path d="M298 392 a22 22 0 0 1 36 -16 a30 30 0 0 1 54 4 a20 20 0 0 1 20 12 Z"/>
  </g>
  <rect y="500" width="1080" height="100" fill="#fff"/>
  ${gingham}
  <!-- plate -->
  <ellipse cx="660" cy="552" rx="272" ry="42" fill="#16245a" opacity=".25"/>
  <ellipse cx="660" cy="540" rx="272" ry="42" fill="#fff"/>
  <ellipse cx="660" cy="540" rx="272" ry="42" fill="none" stroke="#2743a0" stroke-width="7"/>
  <ellipse cx="660" cy="538" rx="204" ry="27" fill="#dfe6ee"/>
  <!-- fork, left of the plate -->
  <g fill="${steel}">
    <path d="M330 600 L334 548 C322 544 316 534 316 520 L316 498 L323 498 L323 522 L329 522 L329 498 L337 498 L337 522 L343 522 L343 498 L351 498 L351 522 L357 522 L357 498 L364 498 L364 520 C364 534 358 544 346 548 L350 600 Z"/>
  </g>
  <!-- knife, right of the plate -->
  <path d="M986 600 L986 556 L982 556 L982 500 C982 490 990 486 997 492 C1012 506 1018 530 1016 556 L1000 556 L1000 600 Z" fill="${steel}"/>
  <!-- tower -->
  <g transform="translate(660 34)">
    <clipPath id="tw"><path d="${shape}"/></clipPath>
    <path d="${shape}" fill="${iron}"/>
    <g clip-path="url(#tw)" stroke="${sky}" stroke-width="3" fill="none" opacity=".9">${lattice}</g>
    <rect x="-17" y="64" width="34" height="12" fill="${iron}"/>
    <rect x="-52" y="246" width="104" height="14" fill="${iron}"/>
    <rect x="-100" y="346" width="200" height="18" fill="${iron}"/>
    <path d="M-164 500 L-100 500 M100 500 L164 500" stroke="${iron}" stroke-width="8"/>
  </g>`;
}

export function petsArt() {
  const bg = '#f6b92c';
  const fur = '#c6622a';
  const furDark = '#7d3a17';
  const cream = '#fff0d2';
  const ink = '#26211f';
  const coal = '#2a2831';
  const spokes = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2;
    return `<line x1="0" y1="0" x2="${(Math.cos(a) * 118).toFixed(1)}" y2="${(Math.sin(a) * 118).toFixed(1)}"/>`;
  }).join('');
  return `
  <rect width="1080" height="600" fill="${bg}"/>
  <rect y="548" width="1080" height="52" fill="#d99a13"/>
  <!-- flat bicycle wheel: round on top, tire squashed flat against the ground -->
  <g transform="translate(910 424)">
    <g stroke="#55524d" stroke-width="3">${spokes}</g>
    <circle r="15" fill="${ink}"/>
    <path d="M-118 66 C-156 -8 -134 -132 0 -132 C134 -132 156 -8 118 66 C112 80 128 106 150 122 L-150 122 C-128 106 -112 80 -118 66 Z" fill="none" stroke="${ink}" stroke-width="22" stroke-linejoin="round"/>
    <path d="M-166 133 L166 133" stroke="${ink}" stroke-width="9" stroke-linecap="round"/>
  </g>
  <!-- cat, sitting under the title -->
  <g transform="translate(232 44) scale(.92)">
    <path d="M86 516 C150 520 176 470 158 420 C150 398 128 404 134 424 C142 456 120 484 80 480 Z" fill="${coal}"/>
    <path d="M-72 560 C-92 480 -74 400 -40 370 L40 370 C74 400 92 480 72 560 Z" fill="${coal}"/>
    <path d="M-68 276 L-74 196 L-22 232 C-8 228 8 228 22 232 L74 196 L68 276 C80 340 44 376 0 376 C-44 376 -80 340 -68 276 Z" fill="${coal}"/>
    <path d="M-60 214 L-34 234 L-60 256 Z M60 214 L34 234 L60 256 Z" fill="#ef7d94"/>
    <ellipse cx="-30" cy="290" rx="19" ry="23" fill="#b9e24c"/><ellipse cx="30" cy="290" rx="19" ry="23" fill="#b9e24c"/>
    <ellipse cx="-30" cy="290" rx="6" ry="19" fill="${ink}"/><ellipse cx="30" cy="290" rx="6" ry="19" fill="${ink}"/>
    <path d="M-9 322 L9 322 L0 333 Z" fill="#ef7d94"/>
    <path d="M-44 322 L-100 310 M-44 334 L-102 340 M44 322 L100 310 M44 334 L102 340" stroke="#d9d6e0" stroke-width="4" stroke-linecap="round"/>
    <path d="M-30 520 L-30 560 M30 520 L30 560" stroke="#55535f" stroke-width="6" stroke-linecap="round"/>
  </g>
  <!-- dog -->
  <g transform="translate(610 0) scale(.86) translate(-720 66)">
    <path d="M610 330 C560 400 546 500 556 566 L884 566 C894 500 880 400 830 330 Z" fill="${fur}"/>
    <path d="M660 366 C650 430 666 500 720 530 C774 500 790 430 780 366 Z" fill="${cream}"/>
    <rect x="630" y="470" width="82" height="110" rx="38" fill="${fur}"/>
    <rect x="728" y="470" width="82" height="110" rx="38" fill="${fur}"/>
    <path d="M720 500 L720 572" stroke="${furDark}" stroke-width="7" stroke-linecap="round"/>
    <ellipse cx="668" cy="574" rx="54" ry="24" fill="${cream}"/>
    <ellipse cx="772" cy="574" rx="54" ry="24" fill="${cream}"/>
    <path d="M618 330 C670 376 770 376 822 330 L830 356 C772 404 668 404 610 356 Z" fill="#0f5a58"/>
    <circle cx="720" cy="398" r="22" fill="#ffd25e" stroke="${ink}" stroke-width="5"/>
    <path d="M552 214 C552 108 628 72 720 72 C812 72 888 108 888 214 C888 300 820 356 720 356 C620 356 552 300 552 214 Z" fill="${fur}"/>
    <path d="M574 116 C510 112 470 178 482 274 C490 330 548 342 572 292 C588 254 586 176 606 130 Z" fill="${furDark}"/>
    <path d="M866 116 C930 112 970 178 958 274 C950 330 892 342 868 292 C852 254 854 176 834 130 Z" fill="${furDark}"/>
    <path d="M630 268 C630 218 676 200 720 200 C764 200 810 218 810 268 C810 318 768 346 720 346 C672 346 630 318 630 268 Z" fill="${cream}"/>
    <path d="M692 300 L748 300 L748 356 C748 388 692 388 692 356 Z" fill="#ef5f7a"/>
    <path d="M720 306 L720 362" stroke="#b83754" stroke-width="5" stroke-linecap="round"/>
    <path d="M664 286 C684 314 708 310 720 288 C732 310 756 314 776 286" fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round"/>
    <path d="M720 264 L720 288" stroke="${ink}" stroke-width="8"/>
    <path d="M684 234 C684 216 756 216 756 234 C756 256 734 270 720 270 C706 270 684 256 684 234 Z" fill="${ink}"/>
    <ellipse cx="704" cy="232" rx="9" ry="5" fill="#fff" opacity=".7"/>
    <circle cx="646" cy="176" r="24" fill="${ink}"/><circle cx="654" cy="168" r="8" fill="#fff"/>
    <circle cx="794" cy="176" r="24" fill="${ink}"/><circle cx="802" cy="168" r="8" fill="#fff"/>
    <path d="M616 138 q28 -22 56 -8 M768 130 q28 -14 56 8" fill="none" stroke="${furDark}" stroke-width="10" stroke-linecap="round"/>
  </g>`;
}

export function magicArt() {
  const night = '#2a1a70';
  const gold = '#ffcf3d';
  const pink = '#ff9bd2';
  const cyan = '#8ae6ff';
  const stars = [[60, 290, 7], [36, 470, 6], [500, 80, 6], [520, 500, 6], [1040, 360, 7], [1000, 520, 6], [540, 240, 5], [300, 250, 6], [880, 110, 5]]
    .map(([x, y, r]) => star4(x, y, r, '#c7b9ff')).join('');
  return `
  <rect width="1080" height="600" fill="${night}"/>
  ${stars}
  <path d="M1000 74 a78 78 0 1 0 60 128 a62 62 0 1 1 -60 -128 Z" fill="${gold}"/>
  <!-- hat with a drooping tip -->
  <g transform="translate(0 6)">
    <path d="M500 366 C566 306 616 236 636 160 C648 110 680 62 740 58 C796 54 850 86 868 138 C840 118 804 116 782 136 C770 200 812 300 884 366 Z" fill="#7a44f0"/>
    <path d="M740 58 C796 54 850 86 868 138 C840 118 804 116 782 136 C772 104 760 76 740 58 Z" fill="#5a2bcb"/>
    ${star4(700, 180, 32, gold)}
    ${star4(752, 284, 24, pink)}
    ${star4(630, 286, 20, cyan)}
    <circle cx="726" cy="104" r="9" fill="${pink}"/>
    <circle cx="662" cy="232" r="7" fill="${cyan}"/>
    <ellipse cx="692" cy="376" rx="296" ry="46" fill="#5a2bcb"/>
    <path d="M522 330 C620 372 764 372 862 330 L878 376 C764 412 620 412 506 376 Z" fill="${gold}"/>
    <rect x="658" y="356" width="68" height="44" fill="${night}" stroke="${gold}" stroke-width="9"/>
  </g>
  <!-- collar and tie: nobody under the hat, dressed for the interview -->
  <g transform="translate(-18 0)">
    <path d="M620 432 L710 468 L688 520 L602 468 Z" fill="#fff"/>
    <path d="M800 432 L710 468 L732 520 L818 468 Z" fill="#fff"/>
    <path d="M690 466 L730 466 L740 500 L756 600 L664 600 L680 500 Z" fill="#e6304f"/>
    <path d="M694 466 L726 466 L736 500 L684 500 Z" fill="#b81e3a"/>
    <path d="M674 548 L746 522 L750 556 L670 586 Z" fill="${gold}"/>
  </g>
  <!-- wand -->
  <g transform="translate(-34 8)">
    <path d="M60 586 L400 330" stroke="#0f0836" stroke-width="22" stroke-linecap="round"/>
    <path d="M60 586 L104 553" stroke="#f4eeff" stroke-width="22" stroke-linecap="round"/>
    <path d="M360 360 L400 330" stroke="#f4eeff" stroke-width="22" stroke-linecap="round"/>
    ${star4(420, 314, 70, gold)}
    ${star4(420, 314, 26, '#fff')}
    ${star4(430, 452, 22, pink)}
    ${star4(330, 256, 18, cyan)}
    ${star4(250, 372, 12, gold)}
  </g>`;
}
