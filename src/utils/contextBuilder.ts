// ===========================================
// CONTEXT BUILDER UTILITY
// Enhanced context building for AI responses
// ===========================================

import { searchSimilar } from './vectorStore';
import { generateEmbedding } from './openai';
import prisma from '../../prisma/client';

export interface ContextChunk {
  text: string;
  score: number;
  source?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ContextOptions {
  creatorId: string;
  userMessage: string;
  conversationHistory: ConversationMessage[];
  maxChunks?: number;
  minScore?: number;
  useHybridSearch?: boolean;
  includeConversationSummary?: boolean;
}

/**
 * Build enhanced context for AI response generation
 * Uses hybrid search (semantic + keyword) and re-ranking
 */
export async function buildEnhancedContext(options: ContextOptions): Promise<{
  relevantChunks: ContextChunk[];
  conversationSummary?: string;
  enhancedHistory: ConversationMessage[];
}> {
  const {
    creatorId,
    userMessage,
    conversationHistory,
    maxChunks = 5,
    minScore = 0.7,
    useHybridSearch = true,
    includeConversationSummary = false,
  } = options;

  // Generate embedding for user message
  const queryEmbedding = await generateEmbedding(userMessage);

  // Semantic search
  const semanticResults = searchSimilar(creatorId, queryEmbedding, maxChunks * 2, minScore);

  // Keyword search (if hybrid search enabled)
  let keywordResults: ContextChunk[] = [];
  if (useHybridSearch) {
    keywordResults = await performKeywordSearch(creatorId, userMessage, maxChunks);
  }

  // Combine and re-rank results
  const combinedResults = combineAndRerank(semanticResults, keywordResults, maxChunks);

  // Build conversation summary if needed
  let conversationSummary: string | undefined;
  if (includeConversationSummary && conversationHistory.length > 10) {
    conversationSummary = await generateConversationSummary(conversationHistory);
  }

  // Enhance conversation history (limit to last 20 messages)
  const enhancedHistory = conversationHistory.slice(-20);

  return {
    relevantChunks: combinedResults,
    conversationSummary,
    enhancedHistory,
  };
}

/**
 * Perform keyword-based search
 */
async function performKeywordSearch(
  creatorId: string,
  query: string,
  maxResults: number
): Promise<ContextChunk[]> {
  // Extract keywords from query
  const keywords = extractKeywords(query);

  if (keywords.length === 0) {
    return [];
  }

  // Search in content chunks
  const chunks = await prisma.contentChunk.findMany({
    where: {
      content: {
        creatorId,
      },
      text: {
        contains: keywords[0], // Search for first keyword
        mode: 'insensitive',
      },
    },
    take: maxResults * 2,
    include: {
      content: {
        select: {
          title: true,
          type: true,
        },
      },
    },
  });

  // Score chunks based on keyword matches
  return chunks.map((chunk) => {
    const text = chunk.text.toLowerCase();
    const score = keywords.reduce((acc, keyword) => {
      const matches = (text.match(new RegExp(keyword.toLowerCase(), 'g')) || []).length;
      return acc + matches * 0.1;
    }, 0.5); // Base score

    return {
      text: chunk.text,
      score: Math.min(score, 1.0),
      source: chunk.content.title,
      metadata: {
        contentType: chunk.content.type,
      },
    };
  });
}

/**
 * Extract keywords from query
 */
function extractKeywords(query: string): string[] {
  // Remove common stop words
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  ]);

  // Extract words (3+ characters, not stop words)
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !stopWords.has(word));

  // Return unique words, sorted by length (longer words are more specific)
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5);
}

/**
 * Combine semantic and keyword results, then re-rank
 */
function combineAndRerank(
  semanticResults: Array<{ text: string; score: number }>,
  keywordResults: ContextChunk[],
  maxResults: number
): ContextChunk[] {
  // Create a map to combine results
  const combinedMap = new Map<string, ContextChunk>();

  // Add semantic results
  semanticResults.forEach((result, _index) => {
    const key = result.text.substring(0, 100); // Use first 100 chars as key
    if (!combinedMap.has(key)) {
      combinedMap.set(key, {
        text: result.text,
        score: result.score * 0.7, // Weight semantic search
      });
    }
  });

  // Add keyword results
  keywordResults.forEach((result) => {
    const key = result.text.substring(0, 100);
    if (combinedMap.has(key)) {
      // Boost score if found in both
      const existing = combinedMap.get(key)!;
      existing.score = Math.min(existing.score + result.score * 0.3, 1.0);
      if (result.source) existing.source = result.source;
      if (result.metadata) existing.metadata = result.metadata;
    } else {
      combinedMap.set(key, result);
    }
  });

  // Convert to array, sort by score, and return top results
  return Array.from(combinedMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Generate conversation summary for long conversations
 */
async function generateConversationSummary(
  conversationHistory: ConversationMessage[]
): Promise<string> {
  // Simple summary: extract key topics and main points
  // In production, this could use OpenAI to generate a proper summary

  const userMessages = conversationHistory
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ');

  // Extract key phrases (simple approach)
  const words = userMessages
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4);

  const wordFreq = new Map<string, number>();
  words.forEach((word) => {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  });

  const topWords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  return `Previous conversation topics: ${topWords.join(', ')}`;
}

/**
 * Calculate temporal weight for content chunks
 * Recent content gets higher weight
 */
export function calculateTemporalWeight(createdAt: Date, daysOld: number): number {
  const maxAge = 365; // 1 year
  const ageRatio = Math.min(daysOld / maxAge, 1);
  // Recent content (0-30 days) gets weight 1.0, older content gets less
  return ageRatio < 0.08 ? 1.0 : Math.max(0.5, 1.0 - ageRatio * 0.5);
}



