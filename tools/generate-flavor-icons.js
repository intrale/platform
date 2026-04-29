// Generador de iconos de launcher por flavor (issue #2505).
// Produce:
//   - drawables vectoriales (foreground / background / monochrome)
//   - mipmap-anydpi-v26/ic_launcher{,_round}.xml con <background>+<foreground>+<monochrome>
//   - raster PNG por densidad (mdpi..xxxhdpi) para ic_launcher y ic_launcher_round
//
// Uso: node tools/generate-flavor-icons.js
//
// Este script es idempotente: sobreescribe los archivos de destino.

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const REPO_ROOT = path.resolve(__dirname, '..');
const FLAVOR_ROOT = path.join(REPO_ROOT, 'app', 'composeApp', 'src');

// Densidades estandar de Android: mdpi=48, hdpi=72, xhdpi=96, xxhdpi=144, xxxhdpi=192
const DENSITIES = [
  { name: 'mdpi', size: 48 },
  { name: 'hdpi', size: 72 },
  { name: 'xhdpi', size: 96 },
  { name: 'xxhdpi', size: 144 },
  { name: 'xxxhdpi', size: 192 },
];

// Especificacion visual por flavor (derivada del brief UX del issue #2505).
// Cada flavor mantiene la silueta Intrale (triangulo stroked) como anclaje de
// marca y se diferencia por paleta + emblema interno.
const FLAVORS = {
  client: {
    gradient: { start: '#FF00D6FF', end: '#FF1890FF' },
    emblem: 'bag',
    emblemColor: '#FFFFB74D', // amber
    background: '#FFFFFFFF',
  },
  business: {
    gradient: { start: '#FF00C853', end: '#FF009688' },
    emblem: 'triangle',
    emblemColor: '#FF263238', // graphite
    background: '#FFFFFFFF',
  },
  delivery: {
    gradient: { start: '#FFFF6B35', end: '#FFF7931E' },
    emblem: 'arrow',
    // Emblema filled con el color final del degrade de marca para que
    // contraste contra el fondo blanco adaptive (brief UX §3).
    emblemColor: '#FFF7931E',
    background: '#FFFFFFFF',
  },
};

// Path del triangulo Intrale (viewport 1024x1024). Mismo que los assets actuales.
const TRI_PATH = 'M512 59.357 L120 738.321 L904 738.321 Z';

// Emblema por tipo. Todos encajan en la keep-safe de 66dp (viewport ~627 centrado).
const EMBLEMS = {
  // Triangulo interno (business): replica el brand mark a escala 1:4.7.
  triangle:
    'M512,384.983 L402,575.508 L622,575.508 Z',
  // Bolsa de compras redondeada (client): cuerpo trapezoidal + asa curva.
  // Cuerpo con esquinas suaves, asa arco semicircular sobre el tope.
  bag:
    'M430,460 C430,449 439,440 450,440 L574,440 C585,440 594,449 594,460 L594,580 C594,596 581,608 566,608 L458,608 C443,608 430,596 430,580 Z' +
    ' M462,440 C462,412 484,390 512,390 C540,390 562,412 562,440 L548,440 C548,420 532,404 512,404 C492,404 476,420 476,440 Z',
  // Flecha inclinada 30deg arriba-derecha (delivery): chevron con asta gruesa.
  // Arranca abajo-izquierda, sube con grosor hacia arriba-derecha, punta chevron.
  arrow:
    'M418,586 L510,494 L462,494 L462,446 L582,446 L582,566 L534,566 L534,518 L442,610 Z',
};

// ---------------------------------------------------------------------------
// Generacion de vector drawables (XML).
// ---------------------------------------------------------------------------

function foregroundVector(flavor) {
  const f = FLAVORS[flavor];
  const emblemPath = EMBLEMS[f.emblem];
  return `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">

    <path
        android:pathData="${TRI_PATH}"
        android:strokeWidth="84"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:fillColor="@android:color/transparent">
        <aapt:attr name="android:strokeColor">
            <gradient
                android:type="linear"
                android:startX="512"
                android:startY="59.357"
                android:endX="512"
                android:endY="738.321">
                <item android:offset="0" android:color="${f.gradient.start}" />
                <item android:offset="1" android:color="${f.gradient.end}" />
            </gradient>
        </aapt:attr>
    </path>

    <path
        android:pathData="${emblemPath}"
        android:fillColor="${f.emblemColor}" />
</vector>
`;
}

function backgroundVector(flavor) {
  const f = FLAVORS[flavor];
  return `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="${f.background}"
        android:pathData="M0,0h108v108h-108z" />
</vector>
`;
}

function monochromeVector(flavor) {
  const emblemPath = EMBLEMS[FLAVORS[flavor].emblem];
  // Monochrome: silueta negra solida (Android 13+ themed icons aplica el tinte).
  // Mantiene el triangulo + emblema para preservar diferenciacion entre flavors
  // incluso cuando el launcher usa wallpaper-based theming.
  return `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">

    <path
        android:pathData="${TRI_PATH}"
        android:strokeColor="#FF000000"
        android:strokeWidth="84"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:fillColor="@android:color/transparent" />

    <path
        android:pathData="${emblemPath}"
        android:fillColor="#FF000000" />
</vector>
`;
}

const ADAPTIVE_ICON_XML = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_intrale_background" />
    <foreground android:drawable="@drawable/ic_intrale_foreground" />
    <monochrome android:drawable="@drawable/ic_intrale_monochrome" />
</adaptive-icon>
`;

// ---------------------------------------------------------------------------
// Rasterizacion PNG via node-canvas.
// ---------------------------------------------------------------------------

function hexToRgba(hex) {
  // soporta #AARRGGBB y #RRGGBB (vector drawable convention).
  const h = hex.replace('#', '');
  if (h.length === 8) {
    const a = parseInt(h.slice(0, 2), 16) / 255;
    const r = parseInt(h.slice(2, 4), 16);
    const g = parseInt(h.slice(4, 6), 16);
    const b = parseInt(h.slice(6, 8), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},1)`;
}

// Dibuja el triangulo Intrale + emblema en el contexto, escalado a `size`.
// `size` es el lado del canvas (48..192). La escala se hace sobre viewport 1024.
// `round` aplica mascara circular para ic_launcher_round.png.
function drawLauncher(ctx, size, flavor, round) {
  const f = FLAVORS[flavor];
  const scale = size / 1024;

  // Fondo.
  ctx.save();
  if (round) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }
  ctx.fillStyle = hexToRgba(f.background);
  ctx.fillRect(0, 0, size, size);

  ctx.scale(scale, scale);

  // Triangulo stroke con gradiente.
  const grad = ctx.createLinearGradient(512, 59.357, 512, 738.321);
  grad.addColorStop(0, hexToRgba(f.gradient.start));
  grad.addColorStop(1, hexToRgba(f.gradient.end));

  ctx.beginPath();
  ctx.moveTo(512, 59.357);
  ctx.lineTo(120, 738.321);
  ctx.lineTo(904, 738.321);
  ctx.closePath();
  ctx.strokeStyle = grad;
  ctx.lineWidth = 84;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Emblema interno.
  ctx.fillStyle = hexToRgba(f.emblemColor);
  drawEmblem(ctx, f.emblem);

  ctx.restore();
}

function drawEmblem(ctx, emblem) {
  ctx.beginPath();
  if (emblem === 'triangle') {
    ctx.moveTo(512, 384.983);
    ctx.lineTo(402, 575.508);
    ctx.lineTo(622, 575.508);
    ctx.closePath();
    ctx.fill();
  } else if (emblem === 'bag') {
    // Cuerpo redondeado (rectangulo con bordes 20 radius aprox).
    roundRect(ctx, 430, 440, 164, 168, 18);
    ctx.fill();
    // Asa: arco encima, trazo grueso en el mismo color.
    ctx.beginPath();
    ctx.lineWidth = 18;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineCap = 'round';
    ctx.arc(512, 440, 50, Math.PI, 0, false);
    ctx.stroke();
  } else if (emblem === 'arrow') {
    // Chevron/flecha arriba-derecha (matches el path XML).
    ctx.moveTo(418, 586);
    ctx.lineTo(510, 494);
    ctx.lineTo(462, 494);
    ctx.lineTo(462, 446);
    ctx.lineTo(582, 446);
    ctx.lineTo(582, 566);
    ctx.lineTo(534, 566);
    ctx.lineTo(534, 518);
    ctx.lineTo(442, 610);
    ctx.closePath();
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function rasterize(flavor, size, round) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  drawLauncher(ctx, size, flavor, round);
  return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------------------
// Salida a disco.
// ---------------------------------------------------------------------------

function writeFileSyncSafe(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function generate(flavor) {
  const resRoot = path.join(FLAVOR_ROOT, flavor, 'res');

  // Vector drawables.
  writeFileSyncSafe(
    path.join(resRoot, 'drawable', 'ic_intrale_foreground.xml'),
    foregroundVector(flavor),
  );
  writeFileSyncSafe(
    path.join(resRoot, 'drawable', 'ic_intrale_background.xml'),
    backgroundVector(flavor),
  );
  writeFileSyncSafe(
    path.join(resRoot, 'drawable', 'ic_intrale_monochrome.xml'),
    monochromeVector(flavor),
  );

  // Adaptive icon XML (ambas variantes apuntan al mismo set).
  writeFileSyncSafe(
    path.join(resRoot, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
    ADAPTIVE_ICON_XML,
  );
  writeFileSyncSafe(
    path.join(resRoot, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'),
    ADAPTIVE_ICON_XML,
  );

  // Raster por densidad (fallback pre-Oreo, minSdk=24).
  for (const { name, size } of DENSITIES) {
    writeFileSyncSafe(
      path.join(resRoot, `mipmap-${name}`, 'ic_launcher.png'),
      rasterize(flavor, size, false),
    );
    writeFileSyncSafe(
      path.join(resRoot, `mipmap-${name}`, 'ic_launcher_round.png'),
      rasterize(flavor, size, true),
    );
  }

  console.log(`[icons] flavor=${flavor} ok -> ${resRoot}`);
}

for (const flavor of Object.keys(FLAVORS)) {
  generate(flavor);
}
console.log('[icons] done.');
