/** Orders saves and recovery writes for each document, even after a failure. */
export class DocumentTasks {
  private pending = new Map<string, Promise<unknown>>()

  run<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task)
    this.pending.set(id, result)
    void result
      .finally(() => {
        if (this.pending.get(id) === result) this.pending.delete(id)
      })
      .catch(() => undefined)
    return result
  }

  async drain() {
    while (this.pending.size)
      await Promise.allSettled([...this.pending.values()])
  }
}
