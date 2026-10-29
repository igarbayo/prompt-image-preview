import { expect, test } from 'claude-code/testing'

import { placeholders } from './register'

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
  await ui.unmount()
})
