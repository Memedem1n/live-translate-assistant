import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  AssistEvent,
  HistoryExportFormat,
  HistoryListResult,
  HistorySessionSummary,
  ReviewLabel,
  ReviewSource,
  SessionHistoryRecord
} from '../../shared/contracts'

const HISTORY_DIR = 'history'
const EXPORT_DIR = 'exports'
const HISTORY_FILE_SUFFIX = '.session.enc'

interface PersistedHistoryPayload {
  version: 1 | 2
  persistedAtMs: number
  record: SessionHistoryRecord
}

interface ReviewCounts {
  reviewedCount: number
  chosenCount: number
  rejectedCount: number
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:]/g, '-')
}

function sanitizeForFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16)
}

function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export class HistoryManager {
  private readonly historyDirPath: string
  private readonly exportDirPath: string

  constructor() {
    const userData = app.getPath('userData')
    this.historyDirPath = path.join(userData, HISTORY_DIR)
    this.exportDirPath = path.join(userData, EXPORT_DIR)
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  persistSession(record: SessionHistoryRecord): boolean {
    if (!this.isEncryptionAvailable()) {
      return false
    }

    this.ensureDir(this.historyDirPath)
    const normalized = this.normalizeRecord(record)
    const filePath = this.findSessionFilePath(normalized.id) || this.buildSessionFilePath(normalized)
    this.writePayload(filePath, normalized)
    return true
  }

  listSessions(): HistoryListResult {
    if (!this.isEncryptionAvailable()) {
      return {
        encryptionAvailable: false,
        sessions: []
      }
    }

    if (!fs.existsSync(this.historyDirPath)) {
      return {
        encryptionAvailable: true,
        sessions: []
      }
    }

    const sessions: HistorySessionSummary[] = []
    const entries = fs
      .readdirSync(this.historyDirPath)
      .filter((name) => name.endsWith(HISTORY_FILE_SUFFIX))

    for (const name of entries) {
      const payload = this.readPayload(path.join(this.historyDirPath, name))
      if (!payload) continue

      sessions.push({
        id: payload.record.id,
        startedAtMs: payload.record.startedAtMs,
        endedAtMs: payload.record.endedAtMs,
        persistedAtMs: payload.persistedAtMs,
        transcriptCount: payload.record.transcripts.length,
        assistCount: payload.record.assists.length,
        ...this.reviewCounts(payload.record)
      })
    }

    sessions.sort((a, b) => b.startedAtMs - a.startedAtMs)

    return {
      encryptionAvailable: true,
      sessions
    }
  }

  getSessionById(sessionId: string): SessionHistoryRecord | null {
    if (!this.isEncryptionAvailable() || !fs.existsSync(this.historyDirPath)) {
      return null
    }

    const entries = fs
      .readdirSync(this.historyDirPath)
      .filter((name) => name.endsWith(HISTORY_FILE_SUFFIX))

    for (const name of entries) {
      const payload = this.readPayload(path.join(this.historyDirPath, name))
      if (!payload) continue
      if (payload.record.id === sessionId) {
        return this.normalizeRecord(payload.record)
      }
    }

    return null
  }

  updateAssistReview(
    sessionId: string,
    assistId: string,
    review: {
      reviewLabel: ReviewLabel
      reviewTags?: string[]
      reviewComment?: string
      reviewSource?: ReviewSource
    }
  ): { record: SessionHistoryRecord; counts: ReviewCounts } | null {
    if (!this.isEncryptionAvailable() || !fs.existsSync(this.historyDirPath)) {
      return null
    }

    const filePath = this.findSessionFilePath(sessionId)
    if (!filePath) {
      return null
    }

    const payload = this.readPayload(filePath)
    if (!payload) {
      return null
    }

    const record = this.normalizeRecord(payload.record)
    const assistIndex = record.assists.findIndex((item) => item.id === assistId)
    if (assistIndex === -1) {
      return null
    }

    const nextTags = Array.from(
      new Set((review.reviewTags || []).map((item) => String(item || '').trim()).filter(Boolean))
    )
    record.assists[assistIndex] = {
      ...record.assists[assistIndex],
      reviewLabel: review.reviewLabel,
      reviewTags: nextTags,
      reviewComment: String(review.reviewComment || '').trim() || undefined,
      reviewedAtMs: Date.now(),
      reviewSource: review.reviewSource || 'ui'
    }

    this.writePayload(filePath, record)
    return {
      record,
      counts: this.reviewCounts(record)
    }
  }

  exportSession(record: SessionHistoryRecord, format: HistoryExportFormat): string {
    this.ensureDir(this.exportDirPath)
    const normalized = this.normalizeRecord(record)

    const fileBase = `session_${formatTimestamp(normalized.startedAtMs)}_${sanitizeForFileName(normalized.id)}`
    const filePath =
      format === 'json'
        ? path.join(this.exportDirPath, `${fileBase}.json`)
        : path.join(this.exportDirPath, `${fileBase}.md`)

    if (format === 'json') {
      fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8')
      return filePath
    }

    const markdown = this.renderMarkdown(normalized)
    fs.writeFileSync(filePath, markdown, 'utf8')
    return filePath
  }

  private readPayload(filePath: string): PersistedHistoryPayload | null {
    try {
      const encryptedBase64 = fs.readFileSync(filePath, 'utf8')
      const decryptedText = safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'))
      const parsed = JSON.parse(decryptedText) as PersistedHistoryPayload

      if (![1, 2].includes(parsed.version) || !parsed.record?.id) {
        return null
      }

      return {
        ...parsed,
        record: this.normalizeRecord(parsed.record)
      }
    } catch {
      return null
    }
  }

  private buildSessionFilePath(record: SessionHistoryRecord): string {
    const fileName = `${formatTimestamp(record.startedAtMs)}_${sanitizeForFileName(record.id)}${HISTORY_FILE_SUFFIX}`
    return path.join(this.historyDirPath, fileName)
  }

  private findSessionFilePath(sessionId: string): string | null {
    if (!fs.existsSync(this.historyDirPath)) {
      return null
    }

    const entries = fs
      .readdirSync(this.historyDirPath)
      .filter((name) => name.endsWith(HISTORY_FILE_SUFFIX))

    for (const name of entries) {
      const filePath = path.join(this.historyDirPath, name)
      const payload = this.readPayload(filePath)
      if (!payload) continue
      if (payload.record.id === sessionId) {
        return filePath
      }
    }

    return null
  }

  private writePayload(filePath: string, record: SessionHistoryRecord): void {
    const payload: PersistedHistoryPayload = {
      version: 2,
      persistedAtMs: Date.now(),
      record: this.normalizeRecord(record)
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString('base64')
    fs.writeFileSync(filePath, encrypted, 'utf8')
  }

  private normalizeAssist(item: AssistEvent): AssistEvent {
    const reviewTags = Array.isArray(item.reviewTags)
      ? Array.from(new Set(item.reviewTags.map((tag) => String(tag || '').trim()).filter(Boolean)))
      : undefined
    return {
      ...item,
      reviewLabel: item.reviewLabel || 'unreviewed',
      reviewTags,
      reviewComment: item.reviewComment ? String(item.reviewComment).trim() : undefined
    }
  }

  private normalizeRecord(record: SessionHistoryRecord): SessionHistoryRecord {
    return {
      ...record,
      schemaVersion: 'session.v2',
      transcripts: (record.transcripts || []).map((item) => ({ ...item })),
      assists: (record.assists || []).map((item) => this.normalizeAssist(item))
    }
  }

  private reviewCounts(record: SessionHistoryRecord): ReviewCounts {
    const assists = record.assists || []
    const chosenCount = assists.filter((item) => item.reviewLabel === 'chosen').length
    const rejectedCount = assists.filter((item) => item.reviewLabel === 'rejected').length
    const reviewedCount = assists.filter(
      (item) => item.reviewLabel && item.reviewLabel !== 'unreviewed' && item.reviewLabel !== 'skipped'
    ).length
    return { reviewedCount, chosenCount, rejectedCount }
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  private renderMarkdown(record: SessionHistoryRecord): string {
    const transcriptLines = record.transcripts
      .map((item) => {
        const confidence = `${Math.round((item.confidence || 0) * 100)}%`
        const language = (item.language || 'unknown').toUpperCase()
        const text = item.text || ''
        return `| ${toIso(item.tEndMs)} | ${item.speaker} | ${language} | ${confidence} | ${escapeMdCell(text)} |`
      })
      .join('\n')

    const assistLines = record.assists
      .map((item) => {
        const mode = item.parseMode || 'n/a'
        const fallback = item.fallbackUsed ? 'yes' : 'no'
        const reviewLabel = item.reviewLabel || 'unreviewed'
        const reviewTags = (item.reviewTags || []).join(', ')
        return `| ${item.state} | ${Math.round(item.latencyMs)} | ${Math.round((item.confidence || 0) * 100)}% | ${mode} | ${fallback} | ${escapeMdCell(
          item.questionTr || ''
        )} | ${escapeMdCell(item.answerEn || '')} | ${escapeMdCell(item.helperAnswerTr || '')} | ${escapeMdCell((item.supportSignals?.riskFlags || []).join(', '))} | ${escapeMdCell(reviewLabel)} | ${escapeMdCell(reviewTags)} | ${escapeMdCell(item.error || '')} |`
      })
      .join('\n')

    const counts = this.reviewCounts(record)

    return [
      '# Interview Copilot Session Export',
      '',
      `- Session ID: \`${record.id}\``,
      `- Started: ${toIso(record.startedAtMs)}`,
      `- Ended: ${toIso(record.endedAtMs)}`,
      `- STT Model: \`${record.sttModel}\``,
      `- Inference Profile: \`${record.inferenceProfileId}\``,
      `- Inference Model: \`${record.inferenceModel}\``,
      `- Transcript Count: ${record.transcripts.length}`,
      `- Assist Count: ${record.assists.length}`,
      `- Reviewed Assists: ${counts.reviewedCount}`,
      `- Chosen Assists: ${counts.chosenCount}`,
      `- Rejected Assists: ${counts.rejectedCount}`,
      '',
      '## Transcripts',
      '',
      '| Time (UTC) | Speaker | Language | Confidence | Text |',
      '| --- | --- | --- | --- | --- |',
      transcriptLines || '| - | - | - | - | - |',
      '',
      '## Assist Outputs',
      '',
      '| State | LatencyMs | Confidence | Parse | Fallback | Question TR | Answer EN | Helper TR | Risk Flags | Review | Review Tags | Error |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      assistLines || '| - | - | - | - | - | - | - | - | - | - | - | - |',
      ''
    ].join('\n')
  }
}

