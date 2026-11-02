import { expect, test } from 'claude-code/testing'

import { isCloseHit, isOnPicture } from './click'
import { placeholders, sizeFor, withoutPlaceholder } from './register'

const BAND = {
  plugin: 'prompt-image-preview',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('placeholders are read from the draft', () => {
  expect(placeholders('look [Image #1] and [Image #3]')).toEqual([1, 3])
  expect(placeholders('no images')).toEqual([])
})

test('without image support the band lists each image as a pressable label', async ($, on) => {
  on('state.get', () => ({
    value: { value: [{ n: 2, path: '/tmp/2.png', width: 800, height: 600 }], version: 1 },
  }))

  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Button', key: 'open2' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'remove2' })).toBeTruthy()
  await ui.unmount()
})

test('a thumbnail box keeps the picture proportions with cells twice as tall as wide', () => {
  const box = (width: number, height: number) => sizeFor({ n: 1, path: '/tmp/1.png', width, height })
  expect(box(800, 600)).toEqual({ columns: 18, rows: 7 })
  expect(box(1920, 1080)).toEqual({ columns: 18, rows: 5 })
  expect(box(600, 600)).toEqual({ columns: 14, rows: 7 })
  expect(box(1200, 1800)).toEqual({ columns: 9, rows: 7 })
  expect(box(3000, 600)).toEqual({ columns: 20, rows: 2 })
  expect(box(0, 0)).toEqual({ columns: 18, rows: 3 })
})

test('removing a placeholder takes one space with it and keeps the cursor in place', () => {
  expect(withoutPlaceholder('look [Image #1] and [Image #2]', 30, 1)).toEqual({ text: 'look and [Image #2]', cursor: 19 })
  expect(withoutPlaceholder('look [Image #1] and [Image #2]', 30, 2)).toEqual({ text: 'look [Image #1] and', cursor: 19 })
  expect(withoutPlaceholder('[Image #3]', 10, 3)).toEqual({ text: '', cursor: 0 })
  expect(withoutPlaceholder('[Image #1] hi', 13, 1)).toEqual({ text: 'hi', cursor: 2 })
  expect(withoutPlaceholder('hi [Image #1] there', 1, 1)).toEqual({ text: 'hi there', cursor: 1 })
  expect(withoutPlaceholder('hi [Image #1] there', 8, 1)).toEqual({ text: 'hi there', cursor: 3 })
  expect(withoutPlaceholder('[Image #12] [Image #1]', 22, 1)).toEqual({ text: '[Image #12]', cursor: 11 })
  expect(withoutPlaceholder('no images', 3, 1)).toEqual({ text: 'no images', cursor: 3 })
})

test('the close badge straddles the top right corner and the margin opens nothing', () => {
  const badge = { radius: 1.25, inset: 0.6 }
  expect(isCloseHit(17.5, 0.5, 18, badge)).toBe(true)
  expect(isCloseHit(17.5, 1.5, 18, badge)).toBe(true)
  expect(isCloseHit(18.5, 0.5, 18, badge)).toBe(true)
  expect(isCloseHit(16.5, 1.5, 18, badge)).toBe(true)
  expect(isCloseHit(9.5, 1.5, 18, badge)).toBe(false)
  expect(isCloseHit(17.5, 3.5, 18, badge)).toBe(false)
  expect(isOnPicture(9.5, 2.5, 18)).toBe(true)
  expect(isOnPicture(9.5, 0.5, 18)).toBe(false)
  expect(isOnPicture(18.5, 4.5, 18)).toBe(false)
})

test('pressing the close button takes the image out of the prompt', async ($, on) => {
  let stored = [
    { n: 1, path: '/tmp/1.png', width: 800, height: 600 },
    { n: 2, path: '/tmp/2.png', width: 800, height: 600 },
  ]
  let filled: unknown
  let version = 1
  on('state.get', () => ({ value: { value: stored, version } }))
  on('state.set', (_$, e) => {
    stored = e.value as typeof stored
    version += 1
    return { value: { isSet: true, version } }
  })
  on('prompt.read', () => ({ value: { text: 'see [Image #1] [Image #2]', cursor: 25 } }))
  on('prompt.fill', (_$, e) => {
    filled = e
    return { isFilled: true, text: 'see [Image #1]', cursor: 14 }
  })

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'remove2' })
  await ui.unmount()

  expect(filled).toMatchObject({ text: 'see [Image #1]', mode: 'replace', cursor: 14 })
  expect(stored.map(one => one.n)).toEqual([1])
})
