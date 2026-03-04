import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorService } from './connectorService'

describe('ConnectorService', () => {
  const importSource = vi.fn()
  const reindex = vi.fn()
  const profileMemory = {
    importSource,
    reindex
  } as any

  beforeEach(() => {
    vi.restoreAllMocks()
    importSource.mockReset()
    reindex.mockReset()
  })

  it('syncs github profile and repos', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          login: 'octocat',
          name: 'The Octocat',
          bio: 'Test user',
          company: '@github',
          location: 'internet',
          public_repos: 2
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            name: 'hello-world',
            description: 'First repo',
            language: 'TypeScript',
            stargazers_count: 7,
            fork: false
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '# Hello World\nSample README'
      })

    vi.stubGlobal('fetch', fetchMock)
    const service = new ConnectorService(profileMemory)

    const status = await service.syncGithub({ username: 'octocat' })
    expect(status.state).toBe('done')
    expect(importSource).toHaveBeenCalled()
    expect(reindex).toHaveBeenCalledTimes(1)
  })

  it('throws on missing username', async () => {
    const service = new ConnectorService(profileMemory)
    await expect(service.syncGithub({ username: '' })).rejects.toThrow('GitHub kullanici adi gerekli.')
  })
})
