// Mac e2e smoke: load vite-built bundle into jsdom, mount, verify pane stage + interact
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS_DIR = '/Volumes/extension/code/zterm/mac/dist/assets';
const BUNDLE = join(
  ASSETS_DIR,
  readdirSync(ASSETS_DIR).find((name) => /^index-.*\.js$/.test(name)) || '',
);
const HTML = '/Volumes/extension/code/zterm/mac/dist/index.html';
const PORT = 5184;

const html = readFileSync(HTML, 'utf8');
const code = readFileSync(BUNDLE, 'utf8');

const vc = new VirtualConsole();
const logs = [];
vc.on('error', (...args) => logs.push(['error', args.map(String).join(' ')]));
vc.on('warn', (...args) => logs.push(['warn', args.map(String).join(' ')]));
vc.on('log', (...args) => logs.push(['log', args.map(String).join(' ')]));
vc.on('jsdomError', (err) => logs.push(['jsdomError', err.message]));

const dom = new JSDOM(html, {
  url: `http://127.0.0.1:${PORT}/`,
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  virtualConsole: vc,
});

const win = dom.window;
win.fetch = () => Promise.resolve({ ok: false });
win.MutationObserver = class { observe(){} disconnect(){} takeRecords(){return [];} };

try {
  win.eval(code);
} catch (err) {
  console.error('bundle eval failed:', err.message);
  console.error('logs:', JSON.stringify(logs.slice(0, 20), null, 2));
  process.exit(1);
}

await new Promise(r => setTimeout(r, 200));

const root = win.document.getElementById('root');
const stageSingle = win.document.querySelector('[data-testid="pane-stage-single"]');
const stageSplit = win.document.querySelector('[data-testid="pane-stage-split"]');
const shellHeader = win.document.querySelector('.mac-shell-header');
const splitBtn = Array.from(win.document.querySelectorAll('button')).find(
  (b) => b.textContent && b.textContent.includes('Split'),
);
const paneTabs = win.document.querySelector('[data-testid^="pane-tabs-"]');
const tabStrip = win.document.querySelector('.mac-tab-strip');
const openConnectionBtn = Array.from(win.document.querySelectorAll('button')).find(
  (b) => b.textContent && b.textContent.includes('Open connection'),
);

const before = {
  rootChildren: root ? root.children.length : -1,
  hasShellHeader: !!shellHeader,
  hasStageSingle: !!stageSingle,
  hasStageSplit: !!stageSplit,
  hasSplitBtn: !!splitBtn,
  splitBtnDisabled: splitBtn ? splitBtn.disabled : null,
  hasPaneTabs: !!paneTabs,
  paneTabsTestId: paneTabs ? paneTabs.getAttribute('data-testid') : null,
  hasTabStrip: !!tabStrip,
  hasOpenConnectionBtn: !!openConnectionBtn,
  tabStripSplitVisible: tabStrip ? tabStrip.getAttribute('data-split-visible') : null,
};
console.log('BEFORE:', JSON.stringify(before, null, 2));

if (splitBtn && !splitBtn.disabled) {
  splitBtn.click();
  await new Promise(r => setTimeout(r, 100));
  const stageAfter = win.document.querySelector('[data-testid="pane-stage-split"]');
  const frames = win.document.querySelectorAll('[data-testid="pane-stage-frame"]');
  const dividers = win.document.querySelectorAll('[data-testid="pane-stage-divider"]');
  const computedStage = stageAfter ? win.getComputedStyle(stageAfter) : null;
  const computedDivider = dividers[0] ? win.getComputedStyle(dividers[0]) : null;
  console.log('AFTER_SPLIT:', JSON.stringify({
    hasStageSplit: !!stageAfter,
    frameCount: frames.length,
    dividerCount: dividers.length,
    splitBtnNowDisabled: splitBtn.disabled,
    stageGap: computedStage ? computedStage.gap : null,
    dividerWidth: computedDivider ? computedDivider.width : null,
  }, null, 2));
}

if (logs.length) {
  console.log('LOGS:', JSON.stringify(logs.slice(0, 10), null, 2));
}
