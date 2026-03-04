import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
import {
  AssistIntentClass,
  InterviewContextPreview,
  InterviewContextPreviewItem,
  ProfileClearSourceRequest,
  ProfileImportRequest,
  ProfileImportResult,
  ProfileReindexResult,
  ProfileSnapshot,
  ProfileSourceRecord,
  ProfileSourceType
} from '../../shared/contracts'

const PROFILE_DIR = 'profile_memory'
const PROFILE_FILE = 'profile_store.enc.json'
const MAX_CHARS_PER_CHUNK = 460
const MAX_CHUNKS_PER_SOURCE = 200

interface ProfileChunk {
  id: string
  sourceId: string
  sourceType: ProfileSourceType
  sourceName: string
  text: string
  normalized: string
  updatedAtMs: number
}

interface StoredSource extends ProfileSourceRecord {
  content: string
}

interface StoredProfilePayload {
  version: 1
  updatedAtMs: number
  sources: StoredSource[]
}

const SOURCE_WEIGHT: Record<ProfileSourceType, number> = {
  job_desc: 0.45,
  cv: 0.35,
  github: 0.3,
  linkedin: 0.25,
  note: 0.2,
  knowledge_base: 0.33,
  web_corpus: 0.31,
  glossary: 0.4
}

const INTENT_MULTIPLIER: Record<AssistIntentClass, Record<ProfileSourceType, number>> = {
  candidate_specific: {
    job_desc: 1.15,
    cv: 1.3,
    github: 1.15,
    linkedin: 1.1,
    note: 1.05,
    knowledge_base: 0.78,
    web_corpus: 0.82,
    glossary: 0.88
  },
  technical_general: {
    job_desc: 0.92,
    cv: 0.62,
    github: 0.95,
    linkedin: 0.58,
    note: 0.88,
    knowledge_base: 1.35,
    web_corpus: 1.25,
    glossary: 1.55
  },
  mixed: {
    job_desc: 1.08,
    cv: 1,
    github: 1.05,
    linkedin: 0.95,
    note: 1,
    knowledge_base: 1.15,
    web_corpus: 1.1,
    glossary: 1.2
  }
}

export interface ProfileRetrieveOptions {
  intentClass?: AssistIntentClass
  allowedSourceTypes?: ProfileSourceType[]
  sourceWeightOverride?: Partial<Record<ProfileSourceType, number>>
}

function sanitizeText(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalize(value: string): string {
  return sanitizeText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(' ')
      .filter((token) => token.length > 1)
  )
}

function clip(value: string, maxLen = 240): string {
  const v = sanitizeText(value)
  if (v.length <= maxLen) return v
  return `${v.slice(0, maxLen)}...`
}

export class ProfileMemoryService {
  private readonly dirPath: string
  private readonly filePath: string
  private payload: StoredProfilePayload
  private chunks: ProfileChunk[]

  constructor() {
    const userData = app.getPath('userData')
    this.dirPath = path.join(userData, PROFILE_DIR)
    this.filePath = path.join(this.dirPath, PROFILE_FILE)
    this.payload = this.loadPayload()
    this.chunks = this.buildChunks(this.payload.sources)
  }

  getSnapshot(): ProfileSnapshot {
    return {
      updatedAtMs: this.payload.updatedAtMs,
      sourceCount: this.payload.sources.length,
      chunkCount: this.chunks.length,
      sources: this.payload.sources.map((item) => this.toSourceRecord(item))
    }
  }

  importSource(request: ProfileImportRequest): ProfileImportResult {
    const content = sanitizeText(request.content)
    if (!content) {
      throw new Error('Kaynak icerigi bos olamaz.')
    }

    const now = Date.now()
    const name = sanitizeText(request.name || request.type.toUpperCase()) || request.type.toUpperCase()
    const sourceId = randomUUID()

    const next: StoredSource = {
      id: sourceId,
      type: request.type,
      name,
      importedAtMs: now,
      updatedAtMs: now,
      contentChars: content.length,
      metadata: request.metadata,
      content
    }

    // Same type+name source gets replaced to keep memory compact and predictable.
    this.payload.sources = this.payload.sources.filter(
      (item) => !(item.type === next.type && item.name.toLowerCase() === next.name.toLowerCase())
    )
    this.payload.sources.push(next)
    this.payload.updatedAtMs = now
    this.chunks = this.buildChunks(this.payload.sources)
    this.savePayload()

    const chunkCount = this.chunks.filter((item) => item.sourceId === sourceId).length
    return {
      success: true,
      source: this.toSourceRecord(next),
      chunkCount
    }
  }

  clearSource(request: ProfileClearSourceRequest): { success: boolean } {
    const before = this.payload.sources.length
    this.payload.sources = this.payload.sources.filter((item) => item.id !== request.sourceId)
    if (before === this.payload.sources.length) {
      return { success: true }
    }
    this.payload.updatedAtMs = Date.now()
    this.chunks = this.buildChunks(this.payload.sources)
    this.savePayload()
    return { success: true }
  }

  reindex(): ProfileReindexResult {
    this.chunks = this.buildChunks(this.payload.sources)
    this.payload.updatedAtMs = Date.now()
    this.savePayload()
    return {
      success: true,
      sourceCount: this.payload.sources.length,
      chunkCount: this.chunks.length
    }
  }

  getContextPreview(query = '', limit = 5, options?: ProfileRetrieveOptions): InterviewContextPreview {
    const items = this.retrieve(query, limit, options)
    return {
      generatedAtMs: Date.now(),
      items
    }
  }

  getContextLines(query: string, limit = 5, options?: ProfileRetrieveOptions): string[] {
    const items = this.retrieve(query, limit, options)
    return items.map((item) => `[profile:${item.sourceType}] ${clip(item.text, 220)}`)
  }

  private retrieve(query: string, limit: number, options?: ProfileRetrieveOptions): InterviewContextPreviewItem[] {
    const sourceFilter = options?.allowedSourceTypes?.length
      ? new Set(options.allowedSourceTypes)
      : null
    const candidateChunks = sourceFilter
      ? this.chunks.filter((chunk) => sourceFilter.has(chunk.sourceType))
      : this.chunks

    if (candidateChunks.length === 0) {
      return []
    }

    const queryTokens = tokenSet(query)
    const scored = candidateChunks.map((chunk) => {
      const baseWeight = SOURCE_WEIGHT[chunk.sourceType] || 0.1
      const intentMultiplier = options?.intentClass
        ? INTENT_MULTIPLIER[options.intentClass]?.[chunk.sourceType] || 1
        : 1
      const manualMultiplier =
        options?.sourceWeightOverride && Number.isFinite(options.sourceWeightOverride[chunk.sourceType])
          ? Number(options.sourceWeightOverride[chunk.sourceType])
          : 1
      const base = baseWeight * intentMultiplier * manualMultiplier
      let lexical = 0
      if (queryTokens.size > 0) {
        const chunkTokens = tokenSet(chunk.normalized)
        let intersection = 0
        for (const token of queryTokens) {
          if (chunkTokens.has(token)) {
            intersection += 1
          }
        }
        lexical = intersection / queryTokens.size
      }
      const recency = Math.max(0, Math.min(1, (Date.now() - chunk.updatedAtMs) / (1000 * 60 * 60 * 24 * 90)))
      const freshness = 1 - recency
      const score = base + lexical * 1.2 + freshness * 0.08
      return { chunk, score }
    })

    const sorted = scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit))
    return sorted.map((item) => ({
      sourceId: item.chunk.sourceId,
      sourceType: item.chunk.sourceType,
      sourceName: item.chunk.sourceName,
      text: item.chunk.text,
      score: Number(item.score.toFixed(4))
    }))
  }

  private buildChunks(sources: StoredSource[]): ProfileChunk[] {
    const output: ProfileChunk[] = []
    for (const source of sources) {
      const parts = this.chunkText(source.content)
      for (const part of parts.slice(0, MAX_CHUNKS_PER_SOURCE)) {
        output.push({
          id: randomUUID(),
          sourceId: source.id,
          sourceType: source.type,
          sourceName: source.name,
          text: part,
          normalized: normalize(part),
          updatedAtMs: source.updatedAtMs
        })
      }
    }
    return output
  }

  private chunkText(raw: string): string[] {
    const normalized = sanitizeText(raw)
    if (!normalized) return []
    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    const chunks: string[] = []
    let current = ''
    for (const line of lines) {
      if (!current) {
        current = line
        continue
      }

      if (`${current}\n${line}`.length > MAX_CHARS_PER_CHUNK) {
        chunks.push(current)
        current = line
      } else {
        current = `${current}\n${line}`
      }
    }
    if (current) {
      chunks.push(current)
    }

    return chunks
      .map((item) => item.trim())
      .filter((item) => item.length >= 24)
  }

  private toSourceRecord(source: StoredSource): ProfileSourceRecord {
    return {
      id: source.id,
      type: source.type,
      name: source.name,
      importedAtMs: source.importedAtMs,
      updatedAtMs: source.updatedAtMs,
      contentChars: source.contentChars,
      metadata: source.metadata
    }
  }

  private loadPayload(): StoredProfilePayload {
    this.ensureDir()
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 1,
        updatedAtMs: Date.now(),
        sources: []
      }
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const decoded = this.decode(raw)
      const parsed = JSON.parse(decoded) as StoredProfilePayload
      if (parsed.version !== 1 || !Array.isArray(parsed.sources)) {
        throw new Error('Invalid profile payload')
      }
      return parsed
    } catch {
      return {
        version: 1,
        updatedAtMs: Date.now(),
        sources: []
      }
    }
  }

  private savePayload(): void {
    this.ensureDir()
    const serialized = JSON.stringify(this.payload, null, 2)
    fs.writeFileSync(this.filePath, this.encode(serialized), 'utf8')
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dirPath)) {
      fs.mkdirSync(this.dirPath, { recursive: true })
    }
  }

  private encode(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return value
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  private decode(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return value
    }
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }
}
