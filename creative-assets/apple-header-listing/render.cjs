/* Run: NODE_PATH=/path/to/node_modules node render.cjs
 * Needs playwright and sharp. Optional CHROMIUM_PATH, PLAYWRIGHT_MODULE, SHARP_MODULE.
 * Uses only local repository assets, opens the local HTML file, closes the browser on completion.
 * Output: two RGB PNGs. Apple dimensions checked 2026-10-18; placement preview not verified.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.SHARP_MODULE || 'sharp');
async function run() {
 let browser;
 try {
  browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
  for (const [placement,width,height] of [['header',3840,1646],['search',3840,2560]]) {
   const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
   const errors=[]; page.on('pageerror',e=>errors.push(e.message));
   await page.goto(pathToFileURL(path.join(__dirname,'artwork.html')).href+'?placement='+placement);
   await page.evaluate(async()=>{
    await document.fonts.ready;
    await Promise.all([...document.images].map(img=>img.decode()));
   });
   if(errors.length)throw new Error(errors.join('\n'));
   const png=await page.locator('#'+placement).screenshot({type:'png',omitBackground:false});
   const dest=path.join(__dirname,`mqvi-${placement}-global.png`);
   await sharp(png).flatten({background:'#0b2029'}).removeAlpha().toColourspace('srgb').png().toFile(dest);
   const meta=await sharp(dest).metadata();
   if(meta.width!==width||meta.height!==height||meta.hasAlpha||meta.channels!==3)throw new Error('Invalid output: '+dest);
   console.log(`${path.basename(dest)}: ${width} × ${height}, RGB, no alpha`);
   await page.close();
  }
 } finally {
  if(browser)await browser.close();
 }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
