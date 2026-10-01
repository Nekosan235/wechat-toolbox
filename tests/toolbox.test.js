const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function drawer() {
  const file = path.join(__dirname, '../components/tool-drawer/index.js')
  const state = { events: [], navigations: [], toasts: [] }
  const wx = {
    navigateTo(r) { state.navigations.push(r.url); r.success({}) },
    showToast(r) { state.toasts.push(r.title) }
  }
  let definition
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Component(value) { definition = value }, wx, require: createRequire(file),
    getCurrentPages: () => state.stack || [], console
  })
  const instance = { ...definition.methods,
    properties: { disabled: false, activeTool: '', fullWidth: false },
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch) },
    triggerEvent(name, detail) { state.events.push({ name, detail }) }
  }
  return { instance, state, definition }
}
const choose = id => ({ currentTarget: { dataset: { id } } })

test('drawer can open, expand, collapse and close with explicit controls', () => {
  const { instance, state } = drawer()
  instance.open()
  assert.equal(instance.data.open, true)
  assert.equal(state.events[0].detail.open, true)
  instance.toggleExpanded()
  assert.equal(instance.data.expanded, true)
  instance.toggleExpanded()
  assert.equal(instance.data.expanded, false)
  instance.close()
  assert.equal(instance.data.open, false)
  assert.equal(state.events.at(-1).detail.open, false)
})

test('drawer drag handle supports expansion and downward dismissal without mandatory gestures', () => {
  const { instance } = drawer()
  instance.open()
  instance.dragStart({ touches: [{ clientY: 400 }] })
  instance.dragMove({ touches: [{ clientY: 330 }] })
  instance.dragEnd()
  assert.equal(instance.data.expanded, true)
  instance.dragStart({ touches: [{ clientY: 200 }] })
  instance.dragMove({ touches: [{ clientY: 350 }] })
  instance.dragEnd()
  assert.equal(instance.data.open, false)
})

test('busy controls cannot open drawer or start navigation', async () => {
  const { instance, state } = drawer()
  instance.properties.disabled = true
  instance.open()
  await instance.selectTool(choose('gif'))
  assert.equal(instance.data.open, false)
  assert.equal(state.navigations.length, 0)
})

test('available tool navigates, active selection closes, future tool never navigates', async () => {
  const { instance, state } = drawer()
  instance.open()
  await instance.selectTool(choose('cutout'))
  assert.equal(state.navigations.length, 0)
  assert.equal(instance.data.open, true)
  assert.match(state.toasts.at(-1), /待开放/)
  instance.properties.activeTool = 'image'
  await instance.selectTool(choose('image'))
  assert.equal(instance.data.open, false)
  assert.equal(state.navigations.length, 0)
  instance.open()
  await instance.selectTool(choose('gif'))
  assert.deepEqual(state.navigations, ['/pages/gif/index'])
})

test('navigation cap does not discard existing pages or edited content', async () => {
  const { instance, state } = drawer()
  state.stack = Array.from({ length: 9 }, () => ({}))
  instance.open()
  await instance.selectTool(choose('gif'))
  assert.equal(state.navigations.length, 0)
  assert.match(state.toasts.at(-1), /返回/)
})

test('hiding parent closes the drawer and reset expanded state', () => {
  const { instance, definition } = drawer()
  instance.open(); instance.toggleExpanded()
  definition.pageLifetimes.hide.call(instance)
  assert.equal(instance.data.open, false)
  assert.equal(instance.data.expanded, false)
})

test('registered home and editor routes resolve; all pages use the same drawer', () => {
  const root = path.join(__dirname, '..')
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.equal(app.pages[0], 'pages/home/index')
  for (const route of app.pages) {
    for (const ext of ['.js', '.wxml', '.wxss', '.json']) assert.ok(fs.existsSync(path.join(root, route + ext)), route + ext)
    const json = JSON.parse(fs.readFileSync(path.join(root, route + '.json'), 'utf8'))
    assert.equal(json.usingComponents['tool-drawer'], '/components/tool-drawer/index')
  }
})
