// ===========================================
// OPENAI UTILITY
// GPT-4o mini for chat, text-embedding-3-small for embeddings
// ===========================================

import OpenAI from 'openai';
import { config } from '../config';

// Initialize OpenAI client (exported so other utils can reuse it)
export const openai = new OpenAI({
  apiKey: config.openai.apiKey
});

// Check if OpenAI is configured
export function isOpenAIConfigured(): boolean {
  return !!config.openai.apiKey;
}

// ===========================================
// EMBEDDINGS
// ===========================================

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI API key not configured');
  }

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000) // Limit input length
  });

  return response.data[0].embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI API key not configured');
  }

  // Process in batches of 100
  const batchSize = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map(t => t.slice(0, 8000));
    
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch
    });

    allEmbeddings.push(...response.data.map(d => d.embedding));
  }

  return allEmbeddings;
}

// ===========================================
// CHAT COMPLETION
// ===========================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
}

export async function generateChatCompletion(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<{ content: string; tokensUsed: number }> {
  if (!isOpenAIConfigured()) {
    throw new Error('OpenAI API key not configured');
  }

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages,
    max_tokens: options.maxTokens || 1000,
    temperature: options.temperature ?? 0.7
  });

  return {
    content: response.choices[0].message.content || '',
    tokensUsed: response.usage?.total_tokens || 0
  };
}

// ===========================================
// CREATOR AI RESPONSE
// ===========================================

export interface PersonaConfig {
  energyLevel?: 'calm' | 'balanced' | 'high-energy';
  honestyStyle?: 'supportive' | 'direct' | 'tough-love';
  humor?: 'none' | 'light' | 'sarcastic';
  responseFormat?: 'short-punchy' | 'detailed' | 'bullet-lists';
  signaturePhrases?: string[];
  opinionatedTopics?: string[];
}

export interface FewShotQA {
  scenario: string;
  answer: string;
}

export interface CreatorContext {
  creatorName: string;
  personality?: string;
  tone?: string;
  responseStyle?: string;
  welcomeMessage?: string;
  personaConfig?: PersonaConfig | null;
  fewShotQA?: FewShotQA[] | null;
  relevantChunks: string[];
  conversationSummary?: string;
}

export async function generateCreatorResponse(
  userMessage: string,
  context: CreatorContext,
  conversationHistory: ChatMessage[] = [],
  conversationSummary?: string
): Promise<{ content: string; tokensUsed: number; qualityScore?: number; citations?: string[] }> {
  // Build system prompt
  const systemPrompt = buildCreatorSystemPrompt(context);

  // Build context from relevant chunks with citations
  const citations: string[] = [];
  const contextText = context.relevantChunks.length > 0
    ? `\n\nRelevant knowledge from my content:\n${context.relevantChunks.map((chunk, index) => {
        const citation = `[${index + 1}]`;
        citations.push(citation);
        return `${citation} ${chunk}`;
      }).join('\n\n')}`
    : '';

  // Add conversation summary if available
  const summaryText = conversationSummary
    ? `\n\nConversation summary: ${conversationSummary}`
    : '';

  // Format reminder — respects personaConfig.responseFormat so personas can diverge on length/style
  const responseFormat = context.personaConfig?.responseFormat;
  const lengthHint = responseFormat === 'detailed'
    ? 'Go into depth — full paragraphs are fine when the question warrants it.'
    : responseFormat === 'short-punchy'
    ? 'Be brief. 1-3 sentences max. Cut anything that isn\'t essential.'
    : 'Match the length to the question — short questions get short answers, complex ones get more.';

  const formatReminder = `\n\nFORMAT REMINDER: plain text only. No bullet points, no bold (**), no headers, no numbered lists, no dashes as list items. Write in sentences like a real person — not a formatted document. ${lengthHint} Do not end with "let me know!" or similar filler.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt + contextText + summaryText + formatReminder },
    ...conversationHistory.slice(-10),
    { role: 'user', content: userMessage }
  ];

  const response = await generateChatCompletion(messages, {
    maxTokens: 800,
    temperature: 0.7
  });

  // Strip markdown that gpt-4o-mini produces despite instructions
  const cleanContent = stripMarkdown(response.content);

  // Calculate quality score (simple heuristic)
  const qualityScore = calculateResponseQuality(cleanContent, userMessage, context.relevantChunks.length);

  return {
    ...response,
    content: cleanContent,
    qualityScore,
    citations: citations.length > 0 ? citations : undefined
  };
}

export function stripMarkdown(text: string): string {
  return text
    // Bold: **text** or __text__ → text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    // Italic: *text* or _text_ → text (avoid stripping lone underscores)
    .replace(/\*([^*]+)\*/g, '$1')
    // Bullet/dash list items at line start → keep the text, remove the marker
    .replace(/^[ \t]*[-•*]\s+/gm, '')
    // Numbered list items: "1. text" → text
    .replace(/^[ \t]*\d+\.\s+/gm, '')
    // Collapse 3+ newlines to double newline
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Calculate response quality score (0-1)
 */
function calculateResponseQuality(
  response: string,
  userMessage: string,
  contextChunksUsed: number
): number {
  let score = 0.5; // Base score

  // Length check (not too short, not too long)
  const length = response.length;
  if (length >= 50 && length <= 1000) {
    score += 0.2;
  }

  // Context usage (using provided context is good)
  if (contextChunksUsed > 0) {
    score += 0.2;
  }

  // Relevance (check if response addresses the question)
  const userKeywords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const responseLower = response.toLowerCase();
  const keywordMatches = userKeywords.filter(kw => responseLower.includes(kw)).length;
  if (keywordMatches > 0) {
    score += Math.min(keywordMatches / userKeywords.length * 0.1, 0.1);
  }

  return Math.min(score, 1.0);
}

function buildCreatorSystemPrompt(context: CreatorContext): string {
  const { creatorName, personality, tone, responseStyle, welcomeMessage, personaConfig, fewShotQA } = context;
  const p = (personaConfig || {}) as PersonaConfig;

  // ── 1. IDENTITY (comes first so it anchors everything) ────────────────────
  let prompt = `You are ${creatorName}, talking directly to a fan. You are a real person, not an AI assistant or bot. Respond exactly as ${creatorName} would — not as a generic helpful assistant.`;

  // ── 2. ENERGY & HONESTY STYLE (core voice — stated before format rules) ──
  if (p.energyLevel === 'calm') {
    prompt += `\n\nEnergy: You are calm, grounded, and measured. No hype. No exclamation points unless truly warranted. Thoughtful and steady — like a trusted mentor talking quietly.`;
  } else if (p.energyLevel === 'high-energy') {
    prompt += `\n\nEnergy: You are high-energy and intense. Short punchy sentences. Direct hits. Exclamation points are fine. You get fired up when talking about what matters.`;
  }

  if (p.honestyStyle === 'supportive') {
    prompt += `\n\nHonesty style: Warm and supportive. Validate the person before offering advice. Lead with empathy — "that makes sense", "I get it". Criticism is gentle and comes after encouragement.`;
  } else if (p.honestyStyle === 'direct') {
    prompt += `\n\nHonesty style: Direct and no-nonsense. Skip the preamble. Say what you mean. No fluff, no "great question!", no softening what needs to be said plainly.`;
  } else if (p.honestyStyle === 'tough-love') {
    prompt += `\n\nHonesty style: Tough love — this is non-negotiable. You do NOT coddle. You do NOT say "it's okay" or "don't be too hard on yourself" or "that's totally normal." You call things out plainly. You believe people rise to high expectations. You are blunt because you respect people enough to tell them the truth. If someone is making excuses, say so directly. NEVER end with a rally cry: no "Get after it!", "Go crush it!", "You've got this!", "Keep pushing!", "You can do it!", "I believe in you!", or any motivational cheerleader line. State the truth and stop.`;
  }

  if (p.humor === 'light') {
    prompt += `\n\nHumor: Light humor is part of your voice — a casual joke or self-aware observation when it fits naturally.`;
  } else if (p.humor === 'sarcastic') {
    prompt += `\n\nHumor: Dry wit and sarcasm are core to how you talk. Use it freely — just not mean-spirited. A well-placed sarcastic line is fine.`;
  } else if (p.humor === 'none') {
    prompt += `\n\nHumor: Keep it serious. No jokes, no banter. Stay on topic and focused.`;
  }

  // ── 3. PERSONALITY / TONE / STYLE (free-text fields) ─────────────────────
  if (personality) {
    prompt += `\n\nWho ${creatorName} is: ${personality}`;
  }
  if (tone) {
    prompt += `\n\nHow ${creatorName} communicates: ${tone}`;
  }
  if (responseStyle) {
    prompt += `\n\nResponse style: ${responseStyle}`;
  }
  if (welcomeMessage) {
    prompt += `\n\nStyle reference — ${creatorName}'s own voice: "${welcomeMessage}"`;
  }

  // ── 4. SIGNATURE PHRASES & OPINIONS ──────────────────────────────────────
  if (p.signaturePhrases && p.signaturePhrases.length > 0) {
    prompt += `\n\nSignature phrases — weave these in naturally when they fit: ${p.signaturePhrases.join(', ')}`;
  }
  if (p.opinionatedTopics && p.opinionatedTopics.length > 0) {
    prompt += `\n\nTopics ${creatorName} has strong opinions on — speak with real conviction here, not diplomatically: ${p.opinionatedTopics.join(', ')}`;
  }

  // ── 5. RESPONSE FORMAT ────────────────────────────────────────────────────
  if (p.responseFormat === 'short-punchy') {
    prompt += `\n\nResponse format: SHORT AND PUNCHY. 1-3 sentences. Every word earns its place. Cut everything else. No lists unless directly asked.`;
  } else if (p.responseFormat === 'detailed') {
    prompt += `\n\nResponse format: Detailed and thorough. Give full answers with real context and depth. Multiple sentences or paragraphs are fine when the question deserves it.`;
  } else if (p.responseFormat === 'bullet-lists') {
    prompt += `\n\nResponse format: Use bullet points or numbered lists to structure your answers when there are multiple parts or steps. Each point should be a complete thought.`;
  } else {
    prompt += `\n\nResponse format: Match length to the question — simple questions get 1-3 sentences, complex questions get more.`;
  }

  // ── 6. FORMATTING RULES (no-markdown, applies to all) ────────────────────
  if (p.responseFormat !== 'bullet-lists') {
    prompt += `\n\nFormatting: Plain text only. No bold (**text**), no headers, no bullet points, no numbered lists, no markdown. Write in natural sentences like a person texting.`;
  } else {
    prompt += `\n\nFormatting: No bold (**text**), no headers, no markdown. Bullet points are fine. Keep each bullet to 1-2 lines.`;
  }

  prompt += `\n\nDO NOT start with: Sure, Absolutely, Of course, Great question, Certainly, I'd be happy, Here are, Let me share — just answer directly.`;
  prompt += `\nDO NOT end with: let me know, hope this helps, feel free to ask.`;

  // ── 7. FEW-SHOT EXAMPLES (most powerful — placed last for recency effect) ─
  if (fewShotQA && fewShotQA.length > 0) {
    const answered = fewShotQA.filter(qa => qa.answer && qa.answer.trim().length > 0);
    if (answered.length > 0) {
      prompt += `\n\nHERE IS EXACTLY HOW ${creatorName.toUpperCase()} TALKS — real answers written by ${creatorName} in their own voice. This is the most important part. Mirror this voice, tone, and style precisely:\n`;
      answered.forEach(qa => {
        prompt += `\nFan: ${qa.scenario}\n${creatorName}: ${qa.answer.trim()}\n`;
      });
      prompt += `\nNow respond to the fan's next message in exactly this same voice.`;
    }
  }

  return prompt;
}

// ===========================================
// TEXT PROCESSING
// ===========================================

// Split text into chunks for embedding
export function chunkText(
  text: string,
  chunkSize: number = 500,
  overlap: number = 100
): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  let currentChunk: string[] = [];
  let currentSize = 0;

  for (const word of words) {
    currentChunk.push(word);
    currentSize++;

    if (currentSize >= chunkSize) {
      chunks.push(currentChunk.join(' '));
      
      // Keep overlap words
      const overlapStart = Math.max(0, currentChunk.length - overlap);
      currentChunk = currentChunk.slice(overlapStart);
      currentSize = currentChunk.length;
    }
  }

  // Add remaining chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }

  return chunks;
}

// Estimate token count (rough approximation)
export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}
