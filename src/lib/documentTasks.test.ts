import { describe, expect, it } from 'vitest'
import { DocumentTasks } from './documentTasks'

describe('document writes', () => {
  it('keeps recovery behind a save and resumes after failure', async () => {
    const tasks = new DocumentTasks()
    let reject!: (error: Error) => void
    const order: string[] = []
    const save = tasks.run(
      'a',
      () =>
        new Promise<void>((_, fail) => {
          order.push('save')
          reject = fail
        }),
    )
    const recovery = tasks.run('a', async () => {
      order.push('recovery')
    })
    const other = tasks.run('b', async () => {
      order.push('other')
    })
    await other
    expect(order).toEqual(['save', 'other'])
    reject(new Error('disk full'))
    await expect(save).rejects.toThrow('disk full')
    await recovery
    await tasks.drain()
    expect(order).toEqual(['save', 'other', 'recovery'])
  })
})
