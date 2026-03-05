import {
  AssistAnswerMode,
  AssistEvent,
  AssistCompositionPolicy,
  AssistIntentClass,
  AssistPersonalizationPolicy,
  InterviewAnswerStyle,
  ProductMode,
  ProfileSourceType,
  ProviderConfig
} from '../../shared/contracts'
import { AssistService } from './assistService'
import { ProfileMemoryService } from './profileMemoryService'
import { classifyAssistIntent, resolveAssistAnswerMode } from '../utils/assistIntent'

const CANDIDATE_SOURCE_TYPES: ProfileSourceType[] = ['cv', 'github', 'linkedin', 'job_desc', 'note']
const KNOWLEDGE_SOURCE_TYPES: ProfileSourceType[] = ['knowledge_base', 'web_corpus', 'glossary']

interface GenerateInterviewAssistInput {
  providerConfig: ProviderConfig
  transcriptId: string
  segmentId?: string
  sourceText: string
  sourceLanguage?: string
  contextLines: string[]
  productMode: ProductMode
  personalizationEnabled: boolean
  assistPersonalizationPolicy: AssistPersonalizationPolicy
  assistCompositionPolicy: AssistCompositionPolicy
  answerStyle: InterviewAnswerStyle
  signal?: AbortSignal
  timeoutMs?: number
  onPartial?: (event: AssistEvent) => void
}

export class InterviewAssistOrchestrator {
  constructor(
    private readonly assistService: AssistService,
    private readonly profileMemory: ProfileMemoryService
  ) {}

  async generate(input: GenerateInterviewAssistInput): Promise<AssistEvent> {
    const intentClass: AssistIntentClass = classifyAssistIntent(input.sourceText)
    const answerMode: AssistAnswerMode = resolveAssistAnswerMode(intentClass, input.assistCompositionPolicy)
    const personalizedContextLines = this.resolvePersonalizedContextLines(input, intentClass)

    const response = await this.assistService.generate({
      providerConfig: input.providerConfig,
      transcriptId: input.transcriptId,
      segmentId: input.segmentId,
      sourceText: input.sourceText,
      sourceLanguage: input.sourceLanguage,
      contextLines: input.contextLines,
      personalizedContextLines,
      answerStyle: input.answerStyle,
      intentClass,
      answerMode,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      onPartial: input.onPartial
    })

    return {
      ...response,
      intentClass,
      answerMode,
      personalizationMode: personalizedContextLines.length > 0 ? 'personalized' : 'generic_fallback'
    }
  }

  private resolvePersonalizedContextLines(
    input: GenerateInterviewAssistInput,
    intentClass: AssistIntentClass
  ): string[] {
    if (input.productMode !== 'interview_live' && input.productMode !== 'interview_practice') {
      return []
    }
    if (!input.personalizationEnabled) {
      return []
    }

    const policy = input.assistPersonalizationPolicy
    if (policy === 'always') {
      return this.combineUnique([
        ...this.lookupContext(input.sourceText, 5, CANDIDATE_SOURCE_TYPES, 'mixed'),
        ...this.lookupContext(input.sourceText, 2, KNOWLEDGE_SOURCE_TYPES, 'mixed')
      ]).slice(0, 7)
    }

    if (intentClass === 'technical_general') {
      return this.combineUnique([
        ...this.lookupContext(input.sourceText, 5, KNOWLEDGE_SOURCE_TYPES, intentClass),
        ...this.lookupContext(input.sourceText, 2, ['github', 'note'], intentClass)
      ]).slice(0, 7)
    }

    if (intentClass === 'candidate_specific') {
      return this.combineUnique([
        ...this.lookupContext(input.sourceText, 6, CANDIDATE_SOURCE_TYPES, intentClass),
        ...this.lookupContext(input.sourceText, 1, KNOWLEDGE_SOURCE_TYPES, intentClass)
      ]).slice(0, 7)
    }

    return this.combineUnique([
      ...this.lookupContext(input.sourceText, 4, CANDIDATE_SOURCE_TYPES, intentClass),
      ...this.lookupContext(input.sourceText, 3, KNOWLEDGE_SOURCE_TYPES, intentClass)
    ]).slice(0, 7)
  }

  private lookupContext(
    query: string,
    limit: number,
    allowedSourceTypes: ProfileSourceType[],
    intentClass: AssistIntentClass
  ): string[] {
    if (limit <= 0 || allowedSourceTypes.length === 0) {
      return []
    }

    return this.profileMemory.getContextLines(query, limit, {
      intentClass,
      allowedSourceTypes
    })
  }

  private combineUnique(items: string[]): string[] {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const item of items) {
      const key = item.trim().toLowerCase()
      if (!key || seen.has(key)) {
        continue
      }
      seen.add(key)
      unique.push(item)
    }
    return unique
  }
}
