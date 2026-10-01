// Browser layout QA derived from the real WXML/WXSS. Not a WeChat emulator.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const assert = require('node:assert/strict')
// Optional developer tool; core tests and the mini program do not need Playwright.
const { chromium } = require(process.env.TOOLBOX_PLAYWRIGHT_PATH || 'playwright')
const root = path.join(__dirname, '..')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-layout-'))
const { tools } = require('../utils/tool-catalog')
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const evaluate = (expression, scope) => vm.runInNewContext(expression, scope)
const interpolate = (text, scope) => text.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => escape(evaluate(expression, scope)))

function parse(source) {
  const tree = { children: [] }
  const stack = [tree]
  const tokens = source.match(/<!--[\s\S]*?-->|<\/?[\w-]+(?:[^>"']|"[^"]*"|'[^']*')*\/?>|[^<]+/g) || []
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) { stack.pop(); continue }
    if (!token.startsWith('<')) { stack.at(-1).children.push(token); continue }
    const tag = /^<([\w-]+)/.exec(token)[1]
    const attrs = {}
    const attrText = token.slice(tag.length + 1).replace(/\/?>$/, '')
    const attrPattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
    for (const match of attrText.matchAll(attrPattern)) attrs[match[1]] = match[2] ?? match[3] ?? ''
    const node = { tag, attrs, children: [] }
    stack.at(-1).children.push(node)
    if (!token.endsWith('/>')) stack.push(node)
  }
  return tree.children
}
const drawerTree = parse(fs.readFileSync(path.join(root, 'components/tool-drawer/index.wxml'), 'utf8'))
function renderNodes(nodes, scope) {
  let result = ''; let branchMatched = false
  for (const node of nodes) {
    if (typeof node === 'string') { result += interpolate(node, scope); continue }
    const a = node.attrs
    const expr = text => evaluate(text.replace(/^\{\{|\}\}$/g, ''), scope)
    if ('wx:if' in a) { branchMatched = !!expr(a['wx:if']); if (!branchMatched) continue }
    else if ('wx:elif' in a) { if (branchMatched) continue; branchMatched = !!expr(a['wx:elif']); if (!branchMatched) continue }
    else if ('wx:else' in a) { if (branchMatched) continue; branchMatched = true }
    else branchMatched = false
    if ('wx:for' in a) {
      result += expr(a['wx:for']).map((item, index) => renderNodes([{ ...node, attrs: Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'wx:for')) }], { ...scope, item, index })).join('')
      continue
    }
    if (node.tag === 'tool-drawer') {
      result += `<section class="drawer-component">${renderNodes(drawerTree, {
        ...scope, activeTool: a['active-tool'] || '', disabled: a.disabled ? !!expr(a.disabled) : false,
        fullWidth: 'full-width' in a, open: !!scope.qaDrawer, expanded: false,
        availableTools: tools.filter(t => t.available), futureTools: tools.filter(t => !t.available)
      })}</section>`
      continue
    }
    const tag = { view: 'div', text: 'span', 'scroll-view': 'div', image: 'img', slider: 'input', switch: 'input', progress: 'progress' }[node.tag] || node.tag
    let attrString = ''
    for (const [key, value] of Object.entries(a)) {
      if (/^wx:|^bind|^catch|^hover|^block|^activeColor|^backgroundColor|^block-color|^mode$|^loading$|^open-type$/.test(key)) continue
      if (key === 'hidden' || key === 'disabled') { if (value && expr(value)) attrString += ` ${key}`; continue }
      if (key === 'type' && node.tag === 'canvas') continue
      attrString += ` ${key}="${interpolate(value, scope)}"`
    }
    if (node.tag === 'slider') attrString += ' type="range"'
    if (node.tag === 'switch') attrString += ' type="checkbox"'
    result += `<${tag}${attrString}>${renderNodes(node.children, scope)}</${tag}>`
  }
  return result
}
function pageData(route) {
  const file = path.join(root, route + '.js')
  let definition
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page(v) { definition = v }, require: createRequire(file) })
  return { ...definition.data }
}
function css(route, width) {
  const texts = ['app.wxss', route + '.wxss', 'components/tool-drawer/index.wxss'].map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  // Component styles are scoped in WeChat; emulate that isolation in QA.
  texts[2] = texts[2].replace(/(^|\})(\s*)([^@{}][^{}]*)(\{)/g, (_, boundary, space, selector, brace) => {
    return boundary + space + selector.split(',').map(part => '.drawer-component ' + part.trim().replace(':host', '')).join(',') + brace
  })
  return texts.join('\n').replace(/(-?[\d.]+)rpx/g, (_, n) => `${Number(n) * width / 750}px`).replace(/(^|\s)page\s*\{/g, '$1body {')
}
async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.TOOLBOX_BROWSER_CHANNEL || 'msedge' })
  try {
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 1 })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      for (const [name, route, patch] of [
        ['home', 'pages/home/index', {}], ['drawer', 'pages/home/index', { qaDrawer: true }],
        ['image', 'pages/index/index', { originalPath: 'example', hasEditable: true, imageSize: '640 × 480', removedPercent: '72', strokeCount: 2 }],
        ['gif', 'pages/gif/index', { loaded: true, frameCount: 6, frameMax: 5, imageSize: '96 × 72 · 6 帧', previewWidth: '100%', previewHeight: 210 }]
      ]) {
        const scope = { ...pageData(route), ...patch }
        // Reproduce the higher-specificity, fixed-width default button style
        // seen in the user's WeChat screenshot. Plain browser buttons miss it.
        const nativeButtons = 'button{box-sizing:border-box;display:block;margin-left:auto;margin-right:auto}button:not([size="mini"]){width:184px}'
        await page.setContent(`<html lang="zh"><style>body{margin:0}div,section{box-sizing:border-box}[scroll-y]{overflow-y:auto}button{border:0;font-family:inherit;cursor:pointer}button[disabled]{cursor:default}input[type=range]{display:block;width:100%;accent-color:#0064d9;min-height:44px}input[type=checkbox]{width:40px;height:24px;accent-color:#34c759}[hidden]{display:none!important}${nativeButtons}${css(route, width)}</style><body>${renderNodes(parse(fs.readFileSync(path.join(root, route + '.wxml'), 'utf8')), scope)}</body></html>`)
        await page.screenshot({ path: path.join(output, `${name}-${width}.png`), fullPage: name === 'image' || name === 'gif' })
        const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && (rect.right > innerWidth + 1 || (rect.left < -1 && !el.classList.contains('processing-canvas')))
        }).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })))
        console.log(JSON.stringify({ name, width, horizontalOverflow: overflow, errors }))
        assert.equal(overflow.length, 0, `${name} ${width}: content overflows the viewport under native button defaults`)
        assert.equal(errors.length, 0, `${name} ${width}: unexpected browser error`)
        if (name === 'home' || name === 'drawer') {
          const rows = await page.locator(name === 'home' ? '.tool-row' : '.drawer-component .tool').evaluateAll(elements => elements.map(el => ({
            rowWidth: el.getBoundingClientRect().width,
            groupWidth: el.parentElement.getBoundingClientRect().width,
            textWidth: el.querySelector('.tool-copy').getBoundingClientRect().width
          })))
          for (const row of rows) {
            assert.ok(Math.abs(row.rowWidth - row.groupWidth) < 2, `${name} ${width}: row must fill group, got ${JSON.stringify(row)}`)
            assert.ok(row.textWidth >= 100, `${name} ${width}: tool text was squeezed into a narrow column`)
          }
        }
      }
      await page.close()
    }
  } finally { await browser.close() }
  console.log('Layout screenshots: ' + output)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
