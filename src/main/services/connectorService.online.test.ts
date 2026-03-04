import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tempRoot = path.join(os.tmpdir(), 'livetranslate-connector-online-tests')

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

import { ConnectorService } from './connectorService'
import { ProfileMemoryService } from './profileMemoryService'

describe('ConnectorService online', () => {
  beforeEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    fs.mkdirSync(tempRoot, { recursive: true })
  })

  it('syncs github public data for a known user', { timeout: 90000 }, async () => {
    const profileMemory = new ProfileMemoryService()
    const connector = new ConnectorService(profileMemory)

    const status = await connector.syncGithub({
      username: 'octocat',
      repoNames: ['Hello-World']
    })

    expect(status.state).toBe('done')
    const snapshot = profileMemory.getSnapshot()
    expect(snapshot.sourceCount).toBeGreaterThan(0)
    expect(snapshot.sources.some((item) => item.type === 'github')).toBe(true)
  })
})
