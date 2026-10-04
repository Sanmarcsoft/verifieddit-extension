export interface Eraser {
  erase (install_id: string, requested_at: number): Promise<void>
}

export interface ErasureRecord {
  install_id: string
  requested_at: number
}

export class InMemoryEraser implements Eraser {
  public readonly queue: ErasureRecord[] = []

  public async erase (install_id: string, requested_at: number): Promise<void> {
    this.queue.push({ install_id, requested_at })
  }
}
