import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tempRoot = path.join(os.tmpdir(), 'livetranslate-profile-memory-tests')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return tempRoot
      }
      return tempRoot
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { ProfileMemoryService } from './profileMemoryService'

describe('ProfileMemoryService', () => {
  beforeEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    fs.mkdirSync(tempRoot, { recursive: true })
  })

  it('imports sources, builds chunks and reindexes', () => {
    const service = new ProfileMemoryService()

    const imported = service.importSource({
      type: 'job_desc',
      name: 'JD',
      content:
        'We are hiring for backend engineer role.\nNeed Node.js, distributed systems, and observability.'
    })
    expect(imported.success).toBe(true)
    expect(imported.chunkCount).toBeGreaterThan(0)

    const snapshot = service.getSnapshot()
    expect(snapshot.sourceCount).toBe(1)
    expect(snapshot.chunkCount).toBeGreaterThan(0)

    const preview = service.getContextPreview('node distributed systems')
    expect(preview.items.length).toBeGreaterThan(0)
    expect(preview.items[0].sourceType).toBe('job_desc')

    const lines = service.getContextLines('node distributed systems', 3)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]).toContain('[profile:job_desc]')

    const reindex = service.reindex()
    expect(reindex.success).toBe(true)
    expect(reindex.sourceCount).toBe(1)
  })

  it('clears source and keeps storage consistent', () => {
    const service = new ProfileMemoryService()
    const imported = service.importSource({
      type: 'note',
      name: 'Personal Note',
      content: 'I worked on Kubernetes autoscaling and incident response.'
    })

    expect(service.getSnapshot().sourceCount).toBe(1)
    const cleared = service.clearSource({ sourceId: imported.source.id })
    expect(cleared.success).toBe(true)
    expect(service.getSnapshot().sourceCount).toBe(0)
    expect(service.getSnapshot().chunkCount).toBe(0)
  })

  it('supports intent-aware retrieval and source filtering', () => {
    const service = new ProfileMemoryService()
    service.importSource({
      type: 'cv',
      name: 'CV',
      content: 'I built internal tooling, hiring workflows, and release planning processes.'
    })
    service.importSource({
      type: 'knowledge_base',
      name: 'NLP Terminology',
      content:
        'Transformer models rely on tokenization, embeddings, attention layers, and decoding strategies.'
    })

    const preview = service.getContextPreview('Explain transformer tokenization', 3, {
      intentClass: 'technical_general'
    })
    expect(preview.items.length).toBeGreaterThan(0)
    expect(preview.items[0].sourceType).toBe('knowledge_base')

    const filtered = service.getContextLines('transformer tokenization', 3, {
      intentClass: 'technical_general',
      allowedSourceTypes: ['knowledge_base']
    })
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.every((line) => line.includes('[profile:knowledge_base]'))).toBe(true)
  })
})
