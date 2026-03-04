import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { GlossaryIngestRequest, WebCorpusSyncRequest } from '../../shared/contracts'

interface BaseScriptResponse {
  ok: boolean
  error?: string
  output?: string
  warnings?: string[]
}

interface WebCorpusScriptResponse extends BaseScriptResponse {
  documents?: number
}

interface GlossaryScriptResponse extends BaseScriptResponse {
  terms?: number
}

export interface ProfileKnowledgeSyncServiceOptions {
  webCorpusScriptPath: string
  glossaryScriptPath: string
  pythonBin: string
  pythonEnv?: NodeJS.ProcessEnv
}

export interface WebCorpusBuildResult {
  outputPath: string
  documents: number
  warnings: string[]
}

export interface GlossaryBuildResult {
  outputPath: string
  terms: number
  warnings: string[]
}

function readNonEmpty(value: unknown): string {
  return String(value || '').trim()
}

export class ProfileKnowledgeSyncService {
  private readonly webCorpusScriptPath: string
  private readonly glossaryScriptPath: string
  private readonly pythonBin: string
  private readonly pythonEnv?: NodeJS.ProcessEnv

  constructor(options: ProfileKnowledgeSyncServiceOptions) {
    this.webCorpusScriptPath = options.webCorpusScriptPath
    this.glossaryScriptPath = options.glossaryScriptPath
    this.pythonBin = options.pythonBin
    this.pythonEnv = options.pythonEnv
  }

  async syncWebCorpus(request: WebCorpusSyncRequest): Promise<WebCorpusBuildResult> {
    if (!fs.existsSync(this.webCorpusScriptPath)) {
      throw new Error('Web corpus script bulunamadi.')
    }

    const args = ['-X', 'utf8', this.webCorpusScriptPath, '--json']
    const configPath = readNonEmpty(request.configPath)
    const outputPath = readNonEmpty(request.outputPath)
    if (configPath) {
      args.push('--config', configPath)
    }
    if (outputPath) {
      args.push('--output', outputPath)
    }
    if (Number.isFinite(request.maxDocs) && Number(request.maxDocs) > 0) {
      args.push('--max-docs', String(Math.floor(Number(request.maxDocs))))
    }
    if (Number.isFinite(request.maxPerCategory) && Number(request.maxPerCategory) > 0) {
      args.push('--max-per-category', String(Math.floor(Number(request.maxPerCategory))))
    }
    if (request.includeSearch === false) {
      args.push('--no-search')
    }

    const payload = (await this.runScript(args)) as WebCorpusScriptResponse
    if (!payload.ok) {
      throw new Error(payload.error || 'Web corpus senkronu basarisiz.')
    }

    const resolvedOutputPath = readNonEmpty(payload.output)
    if (!resolvedOutputPath) {
      throw new Error('Web corpus script output path dondurmedi.')
    }

    return {
      outputPath: resolvedOutputPath,
      documents: Math.max(0, Number(payload.documents || 0)),
      warnings: Array.isArray(payload.warnings)
        ? payload.warnings.map((item) => readNonEmpty(item)).filter(Boolean)
        : []
    }
  }

  async buildGlossary(request: {
    corpusPath: string
    glossaryRequest?: GlossaryIngestRequest
    seedPath?: string
  }): Promise<GlossaryBuildResult> {
    if (!fs.existsSync(this.glossaryScriptPath)) {
      throw new Error('Glossary script bulunamadi.')
    }

    const corpusPath = readNonEmpty(request.corpusPath)
    if (!corpusPath) {
      throw new Error('Glossary olusturma icin corpus path gerekli.')
    }

    const args = ['-X', 'utf8', this.glossaryScriptPath, '--input', corpusPath, '--json']
    const outputPath = readNonEmpty(request.glossaryRequest?.glossaryPath)
    if (outputPath) {
      args.push('--output', outputPath)
    }
    const maxTerms = Number(request.glossaryRequest?.maxTerms || 0)
    if (Number.isFinite(maxTerms) && maxTerms > 0) {
      args.push('--max-terms', String(Math.floor(maxTerms)))
    }
    const seedPath = readNonEmpty(request.seedPath)
    if (seedPath) {
      args.push('--seed', seedPath)
    }

    const payload = (await this.runScript(args)) as GlossaryScriptResponse
    if (!payload.ok) {
      throw new Error(payload.error || 'Glossary olusturma basarisiz.')
    }

    const resolvedOutputPath = readNonEmpty(payload.output)
    if (!resolvedOutputPath) {
      throw new Error('Glossary script output path dondurmedi.')
    }

    return {
      outputPath: resolvedOutputPath,
      terms: Math.max(0, Number(payload.terms || 0)),
      warnings: Array.isArray(payload.warnings)
        ? payload.warnings.map((item) => readNonEmpty(item)).filter(Boolean)
        : []
    }
  }

  private runScript(args: string[]): Promise<BaseScriptResponse> {
    const env = {
      ...this.pythonEnv,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    } as NodeJS.ProcessEnv

    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBin, args, {
        env,
        windowsHide: true
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })

      child.on('error', (error) => {
        reject(error)
      })

      child.on('close', (code) => {
        const output = stdout.trim()
        let parsed: BaseScriptResponse | null = null
        if (output) {
          try {
            parsed = JSON.parse(output) as BaseScriptResponse
          } catch {
            parsed = null
          }
        }

        if (code === 0 && parsed?.ok) {
          resolve(parsed)
          return
        }

        const scriptError = parsed?.error ? ` ${parsed.error}` : ''
        const stderrInfo = stderr.trim() ? ` ${stderr.trim()}` : ''
        reject(new Error(`Knowledge script basarisiz.${scriptError}${stderrInfo}`.trim()))
      })
    })
  }
}
