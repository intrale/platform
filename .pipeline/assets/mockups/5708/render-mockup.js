// Render de verificacion de mockups SVG del issue #5708.
// Uso: node .pipeline/assets/mockups/5708/render-mockup.js <svg> <png> <w> <h>
// Re-ejecutable: sus dos insumos (el SVG y puppeteer) estan versionados/instalados.
const path = require('path');
const puppeteer = require(path.resolve(__dirname, '../../../node_modules/puppeteer'));

const [, , svgArg, pngArg, wArg, hArg] = process.argv;
const width = Number(wArg) || 1240;
const height = Number(hArg) || 1560;

(async () => {
  const svgPath = path.resolve(svgArg);
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const url = 'file:///' + svgPath.split(path.sep).join('/');
  const resp = await page.goto(url, { waitUntil: 'networkidle0' });

  const stats = await page.evaluate(maxW => {
    const svg = document.querySelector('svg');
    if (!svg) return { error: 'no svg root' };
    const texts = Array.from(svg.querySelectorAll('text'));
    const overflowX = texts
      .filter(t => { const b = t.getBBox(); return b.x + b.width > maxW - 4; })
      .map(t => t.textContent.slice(0, 70));
    const overflowY = texts
      .filter(t => t.getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom)
      .map(t => t.textContent.slice(0, 40));
    return {
      texts: texts.length,
      rects: svg.querySelectorAll('rect').length,
      groups: svg.querySelectorAll('g').length,
      overflowX,
      overflowY,
    };
  }, width);

  console.log('status:', resp && resp.status());
  console.log('stats:', JSON.stringify(stats, null, 1));
  console.log('errors:', errors.length ? errors : 'ninguno');
  await page.screenshot({ path: path.resolve(pngArg), fullPage: false });
  await browser.close();
})();
