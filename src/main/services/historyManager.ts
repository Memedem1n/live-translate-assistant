import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  HistoryExportFormat,
  HistoryListResult,
  HistorySessionSummary,
  SessionHistoryRecord
} from '../../shared/contracts'

const HISTORY_DIR = 'history'
const EXPORT_DIR = 'exports'
const HISTORY_FILE_SUFFIX = '.session.enc'

interface PersistedHistoryPayload {
  version: 1
  persistedAtMs: number
  record: SessionHistoryRecord
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

    const payload: PersistedHistoryPayload = {
      version: 1,
      persistedAtMs: Date.now(),
      record
    }

    const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString('base64')
    const fileName = `${formatTimestamp(record.startedAtMs)}_${sanitizeForFileName(record.id)}${HISTORY_FILE_SUFFIX}`
    const filePath = path.join(this.historyDirPath, fileName)

    fs.writeFileSync(filePath, encrypted, 'utf8')
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
    const entries = fs.readdirSync(this.historyDirPath).filter((name) => name.endsWith(HISTORY_FILE_SUFFIX))

    for (const name of entries) {
      const payload = this.readPayload(path.join(this.historyDirPath, name))
      if (!payload) continue

      sessions.push({
        id: payload.record.id,
        startedAtMs: payload.record.startedAtMs,
        endedAtMs: payload.record.endedAtMs,
        persistedAtMs: payload.persistedAtMs,
        transcriptCount: payload.record.transcripts.length,
        assistCount: payload.record.assists.length
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

    const entries = fs.readdirSync(this.historyDirPath).filter((name) => name.endsWith(HISTORY_FILE_SUFFIX))

    for (const name of entries) {
      const payload = this.readPayload(path.join(this.historyDirPath, name))
      if (!payload) continue
      if (payload.record.id === sessionId) {
        return payload.record
      }
    }

    return null
  }

  exportSession(record: SessionHistoryRecord, format: HistoryExportFormat): string {
    this.ensureDir(this.exportDirPath)

    const fileBase = `session_${formatTimestamp(record.startedAtMs)}_${sanitizeForFileName(record.id)}`
    const filePath =
      format === 'json'
        ? path.join(this.exportDirPath, `${fileBase}.json`)
        : path.join(this.exportDirPath, `${fileBase}.md`)

    if (format === 'json') {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8')
      return filePath
    }

    const markdown = this.renderMarkdown(record)
    fs.writeFileSync(filePath, markdown, 'utf8')
    return filePath
  }

  private readPayload(filePath: string): PersistedHistoryPayload | null {
    try {
      const encryptedBase64 = fs.readFileSync(filePath, 'utf8')
      const decryptedText = safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'))
      const parsed = JSON.parse(decryptedText) as PersistedHistoryPayload

      if (parsed.version !== 1 || !parsed.record?.id) {
        return null
      }

      return parsed
    } catch {
      return null
    }
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
        return `| ${toIso(item.tEndMs)} | ${item.speaker} | ${confidence} | ${escapeMdCell(item.textEn)} |`
      })
      .join('\n')

    const assistLines = record.assists
      .map((item) => {
        const mode = item.parseMode || 'n/a'
        const fallback = item.fallbackUsed ? 'yes' : 'no'
        return `| ${item.state} | ${Math.round(item.latencyMs)} | ${Math.round((item.confidence || 0) * 100)}% | ${mode} | ${fallback} | ${escapeMdCell(
          item.translationTr || ''
        )} | ${escapeMdCell(item.replyEn || '')} | ${escapeMdCell(item.replyTr || '')} | ${escapeMdCell(item.error || '')} |`
      })
      .join('\n')

    return [
      '# LiveTranslate Session Export',
      '',
      `- Session ID: \`${record.id}\``,
      `- Started: ${toIso(record.startedAtMs)}`,
      `- Ended: ${toIso(record.endedAtMs)}`,
      `- STT Model: \`${record.sttModel}\``,
      `- Answer Model: \`${record.answerModel}\``,
      `- Transcript Count: ${record.transcripts.length}`,
      `- Assist Count: ${record.assists.length}`,
      '',
      '## Transcripts',
      '',
      '| Time (UTC) | Speaker | Confidence | Text EN |',
      '| --- | --- | --- | --- |',
      transcriptLines || '| - | - | - | - |',
      '',
      '## Assist Outputs',
      '',
      '| State | LatencyMs | Confidence | Parse | Fallback | Translation TR | Reply EN | Reply TR | Error |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      assistLines || '| - | - | - | - | - | - | - | - | - |',
      ''
    ].join('\n')
  }
}
