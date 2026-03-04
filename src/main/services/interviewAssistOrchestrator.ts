import {
  AssistEvent,
  AssistIntentClass,
  AssistOutputPolicy,
  AssistAnswerMode,
  AssistCompositionPolicy,
  AssistLanguagePolicy,
  AssistPersonalizationPolicy,
  AssistantMode,
  InterviewAnswerStyle,
  ProfileSourceType
} from '../../shared/contracts'
import { AssistService } from './assistService'
import { ProfileMemoryService } from './profileMemoryService'
import { classifyAssistIntent, resolveAssistAnswerMode } from '../utils/assistIntent'

const CANDIDATE_SOURCE_TYPES: ProfileSourceType[] = ['cv', 'github', 'linkedin', 'job_desc', 'note']
const KNOWLEDGE_SOURCE_TYPES: ProfileSourceType[] = ['knowledge_base', 'web_corpus', 'glossary']

interface GenerateInterviewAssistInput {
  model: string
  baseUrl: string
  transcriptId: string
  segmentId?: string
  sourceText: string
  sourceLanguage?: string
  outputPolicy?: AssistOutputPolicy
  contextLines: string[]
  assistantMode: AssistantMode
  personalizationEnabled: boolean
  assistPersonalizationPolicy: AssistPersonalizationPolicy
  assistCompositionPolicy: AssistCompositionPolicy
  assistLanguagePolicy: AssistLanguagePolicy
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
    const intentClass: AssistIntentClass | undefined =
      input.assistantMode === 'interview' ? classifyAssistIntent(input.sourceText) : undefined
    const answerMode: AssistAnswerMode | undefined =
      input.assistantMode === 'interview' && intentClass
        ? resolveAssistAnswerMode(intentClass, input.assistCompositionPolicy)
        : undefined
    const personalizedContextLines = this.resolvePersonalizedContextLines(input, intentClass)

    const response = await this.assistService.generate({
      model: input.model,
      baseUrl: input.baseUrl,
      transcriptId: input.transcriptId,
      segmentId: input.segmentId,
      sourceText: input.sourceText,
      sourceLanguage: input.sourceLanguage,
      outputPolicy: input.outputPolicy,
      contextLines: input.contextLines,
      personalizedContextLines,
      assistantMode: input.assistantMode,
      answerStyle: input.answerStyle,
      intentClass,
      answerMode,
      languagePolicy: input.assistLanguagePolicy,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      onPartial: input.onPartial
    })

    return {
      ...response,
      intentClass,
      answerMode,
      languagePolicy: input.assistLanguagePolicy,
      personalizationMode: personalizedContextLines.length > 0 ? 'personalized' : 'generic_fallback'
    }
  }

  private resolvePersonalizedContextLines(
    input: GenerateInterviewAssistInput,
    intentClass?: AssistIntentClass
  ): string[] {
    if (input.assistantMode !== 'interview' || !input.personalizationEnabled) {
      return []
    }

    const policy = input.assistPersonalizationPolicy
    if (policy === 'always' || !intentClass) {
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
