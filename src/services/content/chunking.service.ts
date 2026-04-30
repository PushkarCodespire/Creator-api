// ===========================================
// TEXT CHUNKING SERVICE
// ===========================================
// Intelligent text splitting with semantic awareness
// Based on Phase 4 of the implementation plan
// Custom implementation (LangChain alternative)

import { logWarning, logInfo } from '../../utils/logger';

export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface Chunk {
  text: string;
  index: number;
  characterCount: number;
  wordCount: number;
}

/**
 * Chunk text using LangChain's RecursiveCharacterTextSplitter
 * Optimal chunk size: 800 characters with 100-char overlap
 */
export function chunkContent(
  text: string,
  options: ChunkingOptions = {}
): Chunk[] {
  const {
    chunkSize = 800,
    chunkOverlap = 100
  } = options;

  // Custom recursive character splitter implementation
  // Hierarchical splitting: paragraph -> sentence -> word -> character
  const separators = [
    '\n\n',  // Paragraph breaks (priority 1)
    '\n',    // Line breaks (priority 2)
    '. ',    // Sentence end (priority 3)
    '! ',    // Exclamation (priority 4)
    '? ',    // Question (priority 5)
    '; ',    // Semicolon (priority 6)
    ': ',    // Colon (priority 7)
    ', ',    // Comma (priority 8)
    ' ',     // Space (priority 9)
    ''       // Character (last resort)
  ];

  // Recursive splitting function
  function splitRecursive(text: string, separatorIndex: number): string[] {
    if (separatorIndex >= separators.length) {
      // Last resort: split by character
      return text.length > chunkSize 
        ? [text.substring(0, chunkSize), text.substring(chunkSize)]
        : [text];
    }

    const separator = separators[separatorIndex];
    if (separator === '') {
      // Character-level splitting
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
      }
      return chunks;
    }

    const parts = text.split(separator);
    
    // If splitting by this separator produces chunks that are too large, try next separator
    if (parts.some(part => part.length > chunkSize)) {
      return splitRecursive(text, separatorIndex + 1);
    }

    // Build chunks with overlap
    const chunks: string[] = [];
    let currentChunk = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const separatorToAdd = i > 0 ? separator : '';
      const potentialChunk = currentChunk + separatorToAdd + part;

      if (potentialChunk.length <= chunkSize) {
        currentChunk = potentialChunk;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        // Add overlap
        const overlapStart = Math.max(0, currentChunk.length - chunkOverlap);
        currentChunk = currentChunk.substring(overlapStart) + separatorToAdd + part;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  // Split text into chunks
  const chunks = splitRecursive(text, 0);

  // Validate and format chunks
  const validatedChunks: Chunk[] = chunks
    .map((chunkText, index) => {
      const trimmed = chunkText.trim();
      
      // Filter out invalid chunks
      if (!trimmed || trimmed.length < 50) {
        return null;
      }

      // Check maximum size
      if (trimmed.length > 1500) {
        logWarning(`[Chunking] Chunk ${index} exceeds 1500 chars (${trimmed.length})`);
      }

      return {
        text: trimmed,
        index,
        characterCount: trimmed.length,
        wordCount: trimmed.split(/\s+/).length
      };
    })
    .filter((chunk): chunk is Chunk => chunk !== null);

  // Quality checks
  const avgSize = validatedChunks.reduce((sum, c) => sum + c.characterCount, 0) / validatedChunks.length;
  const sizeStdDev = Math.sqrt(
    validatedChunks.reduce((sum, c) => sum + Math.pow(c.characterCount - avgSize, 2), 0) / validatedChunks.length
  );

  logInfo(`[Chunking] Created ${validatedChunks.length} chunks (avg: ${Math.round(avgSize)} chars, std: ${Math.round(sizeStdDev)})`);

  return validatedChunks;
}

/**
 * Validate chunk quality
 */
export function validateChunks(chunks: Chunk[]): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check minimum chunks
  if (chunks.length === 0) {
    issues.push('No chunks created');
    return { valid: false, issues };
  }

  // Check chunk sizes
  const sizes = chunks.map(c => c.characterCount);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;

  if (minSize < 50) {
    issues.push(`Some chunks are too small (min: ${minSize} chars)`);
  }

  if (maxSize > 1500) {
    issues.push(`Some chunks are too large (max: ${maxSize} chars)`);
  }

  if (avgSize < 300 || avgSize > 1200) {
    issues.push(`Average chunk size is suboptimal (avg: ${Math.round(avgSize)} chars, target: 800)`);
  }

  // Check for empty chunks
  const emptyChunks = chunks.filter(c => !c.text.trim());
  if (emptyChunks.length > 0) {
    issues.push(`${emptyChunks.length} empty chunks found`);
  }

  return {
    valid: issues.length === 0,
    issues
  };
}
