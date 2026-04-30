// ===========================================
// CONTENT ROUTES
// ===========================================

import { Router } from 'express';
import { body, param } from 'express-validator';
import {
  addYouTubeContent,
  addManualContent,
  addFAQContent,
  getCreatorContent,
  getContentDetails,
  deleteContent,
  retrainContent
} from '../controllers/content.controller';
import { authenticate, requireCreator } from '../middleware/auth';
import { autoModerateContent } from '../middleware/ai-moderation.middleware';
import { validate } from '../middleware/validation';
import { validateContent } from '../middleware/content.validation';
// eslint-disable-next-line no-duplicate-imports
import { youtubeUrlSchema, manualContentSchema, faqSchema } from '../middleware/content.validation';
import { uploadVoiceAudio } from '../middleware/upload';
import prisma from '../../prisma/client';

const router = Router();

// All routes require creator authentication
router.use(authenticate, requireCreator);

// Validation rules
const youtubeValidation = [
  body('url')
    .notEmpty()
    .withMessage('YouTube URL is required')
    .matches(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[^\s]+$/)
    .withMessage('Valid YouTube URL is required'),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters'),
];

const _manualContentValidation = [
  body('title')
    .trim()
    .notEmpty()
    .withMessage('Title is required')
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters'),
  body('text')
    .trim()
    .notEmpty()
    .withMessage('Content text is required')
    .isLength({ min: 10, max: 50000 })
    .withMessage('Content must be between 10 and 50,000 characters'),
];

const _faqValidation = [
  body('title')
    .trim()
    .notEmpty()
    .withMessage('Title is required')
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters'),
  body('faqs')
    .isArray({ min: 1 })
    .withMessage('At least one FAQ is required'),
  body('faqs.*.question')
    .trim()
    .notEmpty()
    .withMessage('Question is required')
    .isLength({ min: 5, max: 500 })
    .withMessage('Question must be between 5 and 500 characters'),
  body('faqs.*.answer')
    .trim()
    .notEmpty()
    .withMessage('Answer is required')
    .isLength({ min: 5, max: 2000 })
    .withMessage('Answer must be between 5 and 2000 characters'),
];

const contentIdValidation = [
  param('contentId')
    .isUUID()
    .withMessage('Valid content ID is required'),
];

// Get or generate AI summary
router.get('/ai-summary', async (req, res) => {
  try {
    const creatorId = req.user?.creator?.id;
    if (!creatorId) return res.status(400).json({ success: false, error: { message: 'Creator profile not found' } });

    const creator = await prisma.creator.findUnique({
      where: { id: creatorId },
      select: { aiSummary: true, aiSummaryHash: true },
    });

    // Get current content hash
    const contents = await prisma.creatorContent.findMany({
      where: { creatorId, status: 'COMPLETED' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const currentHash = contents.map(c => c.id).join(',') + ':' + contents.length;

    // If summary exists and hash matches, return cached
    if (creator?.aiSummary && creator?.aiSummaryHash === currentHash) {
      return res.json({ success: true, data: { summary: creator.aiSummary, cached: true } });
    }

    // No cached summary or content changed
    res.json({ success: true, data: { summary: null, cached: false, needsRegenerate: true } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: { message: err instanceof Error ? err.message : String(err) } });
  }
});

// Generate (or regenerate) AI summary
router.post('/ai-summary', async (req, res) => {
  try {
    const { generateChatCompletion } = require('../utils/openai');
    const creatorId = req.user?.creator?.id;
    if (!creatorId) return res.status(400).json({ success: false, error: { message: 'Creator profile not found' } });

    const contents = await prisma.creatorContent.findMany({
      where: { creatorId, status: 'COMPLETED' },
      select: { id: true, title: true, type: true, rawText: true },
      take: 10,
    });

    const creator = await prisma.creator.findUnique({
      where: { id: creatorId },
      select: { displayName: true, aiPersonality: true, aiTone: true, welcomeMessage: true, category: true, bio: true },
    });

    let contentSample = '';
    for (const c of contents) {
      contentSample += `\n[${c.type}: ${c.title}]\n${(c.rawText || '').substring(0, 500)}\n`;
      if (contentSample.length > 4000) break;
    }

    const prompt = `You are analyzing an AI avatar/chatbot for a creator platform. Based on the following creator profile and training content, generate a comprehensive summary.

Creator: ${creator?.displayName || 'Unknown'}
Category: ${creator?.category || 'General'}
Bio: ${creator?.bio || 'Not set'}
AI Personality: ${creator?.aiPersonality || 'Default'}
Tone: ${creator?.aiTone || 'friendly'}
Welcome Message: ${creator?.welcomeMessage || 'Hello!'}

Training Content (${contents.length} sources):
${contentSample}

Generate a summary with these sections:
1. **Who is this AI?** - A brief identity description
2. **Expertise Areas** - What topics can this AI confidently answer about
3. **Communication Style** - How will this AI talk to users
4. **Sample Questions & Answers** - Generate 3 example Q&As showing how this AI would respond
5. **Knowledge Gaps** - What topics might this AI NOT know about
6. **Recommendations** - What additional content should the creator add

Keep it concise and actionable.`;

    const result = await generateChatCompletion([
      { role: 'system', content: 'You are a helpful AI analysis assistant. Respond in markdown format.' },
      { role: 'user', content: prompt },
    ], { model: 'gpt-4o-mini', maxTokens: 1500 });

    // Save to DB
    const currentHash = contents.map(c => c.id).sort((a, b) => a.localeCompare(b)).join(',') + ':' + contents.length;
    await prisma.creator.update({
      where: { id: creatorId },
      data: { aiSummary: result.content, aiSummaryHash: currentHash },
    });

    res.json({ success: true, data: { summary: result.content, cached: false, tokensUsed: result.tokensUsed } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: { message: (err instanceof Error ? err.message : String(err)) || 'Failed to generate summary' } });
  }
});

// Preview YouTube transcript (fetch only, don't process)
router.post('/youtube/preview', validate(youtubeValidation), async (req, res, _next) => {
  try {
    const { fetchCachedTranscript } = require('../services/content/youtube.service');
    const { url } = req.body;
    const result = await fetchCachedTranscript(url);
    res.json({
      success: true,
      data: {
        videoId: result.videoId,
        transcript: result.transcript,
        fullLength: result.transcript?.length || 0,
      }
    });
  } catch (err: unknown) {
    res.status(400).json({ success: false, error: { code: 'APP_ERROR', message: err instanceof Error ? err.message : String(err) } });
  }
});

// Add content (using Zod validation)
router.post('/youtube', validateContent(youtubeUrlSchema), addYouTubeContent);
router.post('/manual', validateContent(manualContentSchema), autoModerateContent('text', 'CREATOR_CONTENT'), addManualContent);
router.post('/faq', validateContent(faqSchema), addFAQContent);

// Get all content
router.get('/', getCreatorContent);

// ========================
// VOICE CLONE — must be before /:contentId routes
// Supports Chatterbox (free, Modal GPU), Inworld TTS (preset voices), and
// ElevenLabs (premium clone). Active provider stored per-creator in voiceProvider.
// ========================

const DEFAULT_INWORLD_VOICE = process.env.INWORLD_DEFAULT_VOICE || 'Hades';

// Upload audio to configure voice.
// - Chatterbox: clones from uploaded audio via Modal GPU endpoint.
// - Inworld: no clone, just records a preset voice name (from req.body.inworldVoice).
// - ElevenLabs: clones from uploaded audio when API key is configured.
router.post('/voice-clone', uploadVoiceAudio, async (req, res) => {
  try {
    const defaultProvider: string =
      req.body.voiceProvider === 'elevenlabs' ? 'elevenlabs' :
      req.body.voiceProvider === 'chatterbox' ? 'chatterbox' : 'inworld';
    const inworldVoice: string = typeof req.body.inworldVoice === 'string' && req.body.inworldVoice.trim()
      ? req.body.inworldVoice.trim()
      : DEFAULT_INWORLD_VOICE;

    const chatterboxSvc = require('../services/voice/chatterbox.service');
    const inworldSvc = require('../services/voice/inworld.service');
    const elevenlabsSvc = require('../services/voice/elevenlabs.service');

    const creatorId = req.user?.creator?.id;
    if (!creatorId) return res.status(400).json({ success: false, error: { message: 'Creator profile not found' } });

    // Inworld needs no audio; Chatterbox and ElevenLabs require an uploaded file.
    const file = req.file;
    if (!file && (defaultProvider === 'elevenlabs' || defaultProvider === 'chatterbox')) {
      return res.status(400).json({ success: false, error: { message: `Audio file is required for ${defaultProvider === 'elevenlabs' ? 'ElevenLabs' : 'Chatterbox'} voice cloning` } });
    }

    const existing = await prisma.creator.findUnique({
      where: { id: creatorId },
      select: {
        displayName: true,
        voiceIdChatterbox: true,
        voiceIdInworld: true,
        voiceIdElevenlabs: true,
      },
    });

    await prisma.creator.update({
      where: { id: creatorId },
      data: { voiceStatus: 'PROCESSING', voiceProvider: defaultProvider },
    });

    // Clean up old cloned voices before replacing (Inworld + ElevenLabs have remote state).
    if (existing?.voiceIdElevenlabs && elevenlabsSvc.isConfigured()) {
      await elevenlabsSvc.deleteVoice(existing.voiceIdElevenlabs).catch(() => {});
    }
    if (existing?.voiceIdInworld && inworldSvc.isConfigured()) {
      await inworldSvc.deleteVoice(existing.voiceIdInworld).catch(() => {});
    }

    const name = `${existing?.displayName || 'Creator'} Voice`;
    const [chatterboxRes, inworldRes, elevenlabsRes] = await Promise.allSettled([
      chatterboxSvc.isConfigured() && file
        ? chatterboxSvc.cloneVoice(name, file.path)
        : Promise.reject(new Error(chatterboxSvc.isConfigured() ? 'No audio file provided' : 'Chatterbox not configured')),
      // Inworld: clone from audio if available, otherwise fall back to preset voice
      inworldSvc.isConfigured()
        ? file
          ? inworldSvc.cloneVoice(name, file.path)
          : Promise.resolve(inworldVoice)
        : Promise.reject(new Error('Inworld not configured')),
      elevenlabsSvc.isConfigured() && file
        ? elevenlabsSvc.cloneVoice(name, file.path)
        : Promise.reject(new Error(elevenlabsSvc.isConfigured() ? 'No audio file provided' : 'ElevenLabs not configured')),
    ]);

    const voiceIdChatterbox = chatterboxRes.status === 'fulfilled' ? chatterboxRes.value : null;
    const voiceIdInworld = inworldRes.status === 'fulfilled' ? inworldRes.value : null;
    const voiceIdElevenlabs = elevenlabsRes.status === 'fulfilled' ? elevenlabsRes.value : null;

    // Use primary provider result; fall back to chatterbox if primary failed
    const primaryId =
      defaultProvider === 'elevenlabs' ? voiceIdElevenlabs :
      defaultProvider === 'chatterbox' ? voiceIdChatterbox : voiceIdInworld;
    const defaultId = primaryId || voiceIdChatterbox;
    const effectiveProvider = primaryId ? defaultProvider : (voiceIdChatterbox ? 'chatterbox' : null);

    if (!defaultId || !effectiveProvider) {
      const defaultErr =
        defaultProvider === 'elevenlabs' ? elevenlabsRes :
        defaultProvider === 'chatterbox' ? chatterboxRes : inworldRes;
      const msg = defaultErr.status === 'rejected'
        ? (defaultErr.reason instanceof Error ? defaultErr.reason.message : String(defaultErr.reason))
        : 'Voice setup failed';
      await prisma.creator.update({
        where: { id: creatorId },
        data: { voiceStatus: 'FAILED' },
      }).catch(() => {});
      return res.status(500).json({ success: false, error: { message: msg } });
    }

    await prisma.creator.update({
      where: { id: creatorId },
      data: {
        voiceId: defaultId,
        voiceIdChatterbox,
        voiceIdInworld,
        voiceIdElevenlabs,
        voiceStatus: 'READY',
        voiceProvider: effectiveProvider,
      },
    });

    res.json({
      success: true,
      data: {
        voiceId: defaultId,
        status: 'READY',
        voiceProvider: effectiveProvider,
        providers: {
          chatterbox: !!voiceIdChatterbox,
          inworld: !!voiceIdInworld,
          elevenlabs: !!voiceIdElevenlabs,
        },
      },
    });
  } catch (err: unknown) {
    const creatorId = req.user?.creator?.id;
    if (creatorId) {
      await prisma.creator.update({
        where: { id: creatorId },
        data: { voiceStatus: 'FAILED' },
      }).catch(() => {});
    }
    res.status(500).json({ success: false, error: { message: (err instanceof Error ? err.message : String(err)) || 'Voice clone failed' } });
  }
});

// Get voice clone status
router.get('/voice-clone', async (req, res) => {
  try {
    const creatorId = req.user?.creator?.id;
    if (!creatorId) return res.status(400).json({ success: false, error: { message: 'Creator profile not found' } });

    const creator = await prisma.creator.findUnique({
      where: { id: creatorId },
      select: {
        voiceId: true,
        voiceIdChatterbox: true,
        voiceIdInworld: true,
        voiceIdElevenlabs: true,
        voiceStatus: true,
        voiceProvider: true,
      },
    });

    res.json({
      success: true,
      data: {
        voiceId: creator?.voiceId,
        status: creator?.voiceStatus,
        voiceProvider: creator?.voiceProvider || 'inworld',
        providers: {
          chatterbox: !!creator?.voiceIdChatterbox,
          inworld: !!creator?.voiceIdInworld,
          elevenlabs: !!creator?.voiceIdElevenlabs,
        },
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: { message: err instanceof Error ? err.message : String(err) } });
  }
});

// Delete voice clone
router.delete('/voice-clone', async (req, res) => {
  try {
    const creatorId = req.user?.creator?.id;
    if (!creatorId) return res.status(400).json({ success: false, error: { message: 'Creator profile not found' } });

    const creator = await prisma.creator.findUnique({
      where: { id: creatorId },
      select: { voiceIdChatterbox: true, voiceIdInworld: true, voiceIdElevenlabs: true },
    });

    const elevenlabsSvc = require('../services/voice/elevenlabs.service');

    if (creator?.voiceIdElevenlabs && elevenlabsSvc.isConfigured()) {
      await elevenlabsSvc.deleteVoice(creator.voiceIdElevenlabs).catch(() => {});
    }

    await prisma.creator.update({
      where: { id: creatorId },
      data: {
        voiceId: null,
        voiceIdChatterbox: null,
        voiceIdInworld: null,
        voiceIdElevenlabs: null,
        voiceStatus: null,
      },
    });

    res.json({ success: true, data: { message: 'Voice clone deleted' } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: { message: err instanceof Error ? err.message : String(err) } });
  }
});

// Get content details
router.get('/:contentId', validate(contentIdValidation), getContentDetails);

// Delete content
router.delete('/:contentId', validate(contentIdValidation), deleteContent);

// Retrain content
router.post('/:contentId/retrain', validate(contentIdValidation), retrainContent);

export default router;
