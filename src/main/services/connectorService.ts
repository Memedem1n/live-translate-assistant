import { ProfileSyncStatus, GithubSyncRequest } from '../../shared/contracts'
import { ProfileMemoryService } from './profileMemoryService'

interface GithubRepo {
  name: string
  description: string | null
  language: string | null
  stargazers_count: number
  fork: boolean
}

interface GithubUser {
  login: string
  name: string | null
  bio: string | null
  company: string | null
  location: string | null
  public_repos: number
}

function emitStatus(
  cb: ((status: ProfileSyncStatus) => void) | undefined,
  status: Omit<ProfileSyncStatus, 'updatedAtMs'>
): ProfileSyncStatus {
  const payload: ProfileSyncStatus = {
    ...status,
    updatedAtMs: Date.now()
  }
  cb?.(payload)
  return payload
}

export class ConnectorService {
  constructor(private readonly profileMemory: ProfileMemoryService) {}

  async syncGithub(
    request: GithubSyncRequest,
    options?: { onStatus?: (status: ProfileSyncStatus) => void }
  ): Promise<ProfileSyncStatus> {
    const username = String(request.username || '').trim()
    if (!username) {
      throw new Error('GitHub kullanici adi gerekli.')
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Interview-Copilot'
    }
    if (request.token) {
      headers.Authorization = `Bearer ${request.token}`
    }

    emitStatus(options?.onStatus, {
      state: 'running',
      sourceType: 'github',
      message: 'GitHub profili aliniyor...',
      progress: 0.1
    })

    const userResp = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
      headers
    })
    if (!userResp.ok) {
      throw new Error(`GitHub profil okunamadi (${userResp.status}).`)
    }
    const user = (await userResp.json()) as GithubUser
    const profileText = [
      `GitHub Login: ${user.login}`,
      `Name: ${user.name || '-'}`,
      `Bio: ${user.bio || '-'}`,
      `Company: ${user.company || '-'}`,
      `Location: ${user.location || '-'}`,
      `Public Repos: ${user.public_repos}`
    ].join('\n')

    this.profileMemory.importSource({
      type: 'github',
      name: `GitHub Profile (${username})`,
      content: profileText,
      metadata: {
        username
      }
    })

    emitStatus(options?.onStatus, {
      state: 'running',
      sourceType: 'github',
      message: 'Repository bilgileri aliniyor...',
      progress: 0.35
    })

    const reposResp = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=30&sort=updated`,
      { headers }
    )
    if (!reposResp.ok) {
      throw new Error(`GitHub repo listesi okunamadi (${reposResp.status}).`)
    }
    const repos = ((await reposResp.json()) as GithubRepo[])
      .filter((repo) => !repo.fork)
      .filter((repo) =>
        request.repoNames?.length
          ? request.repoNames.some((name) => name.toLowerCase() === repo.name.toLowerCase())
          : true
      )
      .slice(0, 8)

    let processed = 0
    for (const repo of repos) {
      const readmeResp = await fetch(
        `https://raw.githubusercontent.com/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/HEAD/README.md`,
        { headers: { 'User-Agent': 'Interview-Copilot' } }
      )

      const readmeText = readmeResp.ok ? await readmeResp.text() : ''
      const content = [
        `Repository: ${repo.name}`,
        `Description: ${repo.description || '-'}`,
        `Primary Language: ${repo.language || '-'}`,
        `Stars: ${repo.stargazers_count}`,
        '',
        readmeText.trim()
      ]
        .filter(Boolean)
        .join('\n')

      if (content.trim().length > 20) {
        this.profileMemory.importSource({
          type: 'github',
          name: `Repo ${repo.name}`,
          content,
          metadata: {
            username,
            repo: repo.name
          }
        })
      }

      processed += 1
      emitStatus(options?.onStatus, {
        state: 'running',
        sourceType: 'github',
        message: `${processed}/${repos.length} repo islendi`,
        progress: 0.35 + (processed / Math.max(1, repos.length)) * 0.6
      })
    }

    this.profileMemory.reindex()
    return emitStatus(options?.onStatus, {
      state: 'done',
      sourceType: 'github',
      message: `GitHub senkron tamamlandi (${processed} repo).`,
      progress: 1
    })
  }
}

