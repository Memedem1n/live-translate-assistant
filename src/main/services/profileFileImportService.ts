import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { ProfileImportOcrMode, ProfileImportParser } from '../../shared/contracts'

interface ExtractScriptResponse {
  ok: boolean
  error?: string
  text?: string
  parser?: string
  ocr_used?: boolean
  warnings?: string[]
  metadata?: Record<string, unknown>
}

export interface ProfileFileExtractResult {
  text: string
  parser: ProfileImportParser
  ocrUsed: boolean
  warnings: string[]
  metadata: Record<string, unknown>
}

interface ProfileFileImportServiceOptions {
  scriptPath: string
  pythonBin: string
  pythonEnv?: NodeJS.ProcessEnv
}

function parseImportParser(value: string | undefined): ProfileImportParser {
  if (value === 'docx') return 'docx'
  if (value === 'pdf_text') return 'pdf_text'
  if (value === 'ocr') return 'ocr'
  return 'text'
}

function safeTrim(value: unknown): string {
  return String(value ?? '').trim()
}

export class ProfileFileImportService {
  private readonly scriptPath: string
  private readonly pythonBin: string
  private readonly pythonEnv?: NodeJS.ProcessEnv

  constructor(options: ProfileFileImportServiceOptions) {
    this.scriptPath = options.scriptPath
    this.pythonBin = options.pythonBin
    this.pythonEnv = options.pythonEnv
  }

  async extractFromFile(filePath: string, ocrMode: ProfileImportOcrMode): Promise<ProfileFileExtractResult> {
    const resolvedPath = safeTrim(filePath)
    if (!resolvedPath) {
      throw new Error('Dosya yolu bos.')
    }
    if (!fs.existsSync(resolvedPath)) {
      throw new Error('Secilen dosya bulunamadi.')
    }
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error('Metin cikarma scripti bulunamadi.')
    }

    const payload = await this.runScript(resolvedPath, ocrMode)
    if (!payload.ok) {
      throw new Error(payload.error || 'Dosya okunamadi.')
    }

    const text = safeTrim(payload.text)
    if (!text) {
      throw new Error('Dosyadan anlamli metin cikmadi.')
    }

    return {
      text,
      parser: parseImportParser(payload.parser),
      ocrUsed: payload.ocr_used === true,
      warnings: Array.isArray(payload.warnings)
        ? payload.warnings
            .map((item) => String(item || '').trim())
            .filter(Boolean)
        : [],
      metadata:
        payload.metadata && typeof payload.metadata === 'object'
          ? payload.metadata
          : ({} as Record<string, unknown>)
    }
  }

  private runScript(filePath: string, ocrMode: ProfileImportOcrMode): Promise<ExtractScriptResponse> {
    const args = ['-X', 'utf8', this.scriptPath, '--path', filePath, '--ocr', ocrMode, '--json']
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
        let parsed: ExtractScriptResponse | null = null
        if (output) {
          try {
            parsed = JSON.parse(output) as ExtractScriptResponse
          } catch {
            // Keep parsed null and use raw logs in error message.
          }
        }

        if (code === 0 && parsed?.ok) {
          resolve(parsed)
          return
        }

        const scriptError = parsed?.error ? ` ${parsed.error}` : ''
        const stderrInfo = stderr.trim() ? ` ${stderr.trim()}` : ''
        reject(new Error(`Dosya metni cikarma basarisiz.${scriptError}${stderrInfo}`.trim()))
      })
    })
  }
}
