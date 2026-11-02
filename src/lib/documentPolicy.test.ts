import { describe, expect, it } from 'vitest'
import { previewPolicy, recoveryDelay } from './documentPolicy'

describe('recovery timing', () => {
  it.each([
    [1_000, 1_000, 1_000, 1_000],
    [1_000, 5_500, 1_000, 500],
    [1_000, 6_000, 1_000, 0],
    [1_000, 6_500, 1_000, 0],
    [1_000, 1_000, 0, 0],
    [1_000, 5_500, 100, 100],
  ])(
    'bounds a write started at %i and scheduled at %i with delay %i to %i ms',
    (firstAt, now, delay, expected) => {
      expect(recoveryDelay(firstAt, now, delay)).toBe(expected)
    },
  )
})

describe('preview size policy', () => {
  it.each([
    [0, false, false],
    [512 * 1024, false, false],
    [512 * 1024 + 1, false, true],
    [2 * 1024 * 1024, false, true],
    [2 * 1024 * 1024 + 1, true, false],
  ])(
    'classifies %i bytes with unavailable=%s and manual=%s',
    (bytes, previewTooLarge, previewNeedsManual) => {
      expect(previewPolicy(bytes)).toEqual({
        previewTooLarge,
        previewNeedsManual,
      })
    },
  )
})
