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

const PERSONAL_EVIDENCE_SOURCE_TYPES: ProfileSourceType[] = ['cv', 'github', 'linkedin', 'note']
const CANDIDATE_SUPPORT_SOURCE_TYPES: ProfileSourceType[] = ['job_desc']
const KNOWLEDGE_SOURCE_TYPES: ProfileSourceType[] = ['knowledge_base', 'web_corpus', 'glossary']

interface ResolvedContextBundle {
  supportingContextLines: string[]
  personalEvidenceLines: string[]
  requiresHonestExperienceDisclosure: boolean
}

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
    const resolvedContext = this.resolveContextBundle(input, intentClass)

    const response = await this.assistService.generate({
      providerConfig: input.providerConfig,
      transcriptId: input.transcriptId,
      segmentId: input.segmentId,
      sourceText: input.sourceText,
      sourceLanguage: input.sourceLanguage,
      contextLines: input.contextLines,
      supportingContextLines: resolvedContext.supportingContextLines,
      personalEvidenceLines: resolvedContext.personalEvidenceLines,
      requiresHonestExperienceDisclosure: resolvedContext.requiresHonestExperienceDisclosure,
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
      personalizationMode:
        resolvedContext.personalEvidenceLines.length > 0 ? 'personalized' : 'generic_fallback'
    }
  }

  private resolveContextBundle(
    input: GenerateInterviewAssistInput,
    intentClass: AssistIntentClass
  ): ResolvedContextBundle {
    const emptyResult: ResolvedContextBundle = {
      supportingContextLines: [],
      personalEvidenceLines: [],
      requiresHonestExperienceDisclosure: false
    }

    if (input.productMode !== 'interview_live' && input.productMode !== 'interview_practice') {
      return emptyResult
    }
    if (!input.personalizationEnabled) {
      return emptyResult
    }

    const policy = input.assistPersonalizationPolicy
    let personalEvidenceLines: string[] = []
    let candidateSupportLines: string[] = []
    let knowledgeContextLines: string[] = []

    if (policy === 'always') {
      personalEvidenceLines = this.lookupContext(
        input.sourceText,
        4,
        PERSONAL_EVIDENCE_SOURCE_TYPES,
        'mixed'
      )
      candidateSupportLines = this.lookupContext(
        input.sourceText,
        1,
        CANDIDATE_SUPPORT_SOURCE_TYPES,
        'mixed'
      )
      knowledgeContextLines = this.lookupContext(input.sourceText, 2, KNOWLEDGE_SOURCE_TYPES, 'mixed')
    } else if (intentClass === 'technical_general') {
      personalEvidenceLines = this.lookupContext(input.sourceText, 2, ['github', 'note'], intentClass)
      knowledgeContextLines = this.lookupContext(input.sourceText, 5, KNOWLEDGE_SOURCE_TYPES, intentClass)
    } else if (intentClass === 'candidate_specific') {
      personalEvidenceLines = this.lookupContext(
        input.sourceText,
        6,
        PERSONAL_EVIDENCE_SOURCE_TYPES,
        intentClass
      )
      candidateSupportLines = this.lookupContext(
        input.sourceText,
        1,
        CANDIDATE_SUPPORT_SOURCE_TYPES,
        intentClass
      )
      knowledgeContextLines = this.lookupContext(input.sourceText, 2, KNOWLEDGE_SOURCE_TYPES, intentClass)
    } else {
      personalEvidenceLines = this.lookupContext(
        input.sourceText,
        3,
        PERSONAL_EVIDENCE_SOURCE_TYPES,
        intentClass
      )
      candidateSupportLines = this.lookupContext(
        input.sourceText,
        1,
        CANDIDATE_SUPPORT_SOURCE_TYPES,
        intentClass
      )
      knowledgeContextLines = this.lookupContext(input.sourceText, 3, KNOWLEDGE_SOURCE_TYPES, intentClass)
    }

    return {
      supportingContextLines: this.combineUnique([
        ...personalEvidenceLines,
        ...candidateSupportLines,
        ...knowledgeContextLines
      ]).slice(0, 7),
      personalEvidenceLines: this.combineUnique(personalEvidenceLines).slice(0, 6),
      requiresHonestExperienceDisclosure:
        intentClass === 'candidate_specific' && personalEvidenceLines.length === 0
    }
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
