import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { isCloudinaryConfigured, uploadToCloudinary } from '../../utils/cloudinary';

const INWORLD_TTS_BASE = 'https://api.inworld.ai';
const INWORLD_VOICES_BASE = 'https://api.inworld.ai';
const INWORLD_MODEL_ID = 'inworld-tts-1.5-mini';

function getApiKey(): string {
  const key = process.env.INWORLD_API_KEY;
  if (!key) throw new Error('INWORLD_API_KEY not configured');
  return key;
}

function authHeader() {
  return { 'Authorization': `Basic ${getApiKey()}` };
}

/**
 * Clone a voice from an uploaded audio file using Inworld's instant voice cloning.
 * Returns the cloned voiceId (format: "{workspace}__{voice}") to store in the DB.
 */
export async function cloneVoice(name: string, audioFilePath: string): Promise<string> {
  const audioData = fs.readFileSync(audioFilePath).toString('base64');

  const res = await axios.post(
    `${INWORLD_VOICES_BASE}/voices/v1/voices:clone`,
    {
      displayName: name,
      langCode: 'AUTO',
      voiceSamples: [{ audioData }],
      audioProcessingConfig: { removeBackgroundNoise: true },
    },
    {
      headers: {
        ...authHeader(),
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  return res.data.voice.voiceId;
}

/**
 * Delete a previously cloned Inworld voice.
 */
export async function deleteVoice(voiceId: string): Promise<void> {
  await axios.delete(
    `${INWORLD_VOICES_BASE}/voices/v1/voices/${encodeURIComponent(voiceId)}`,
    {
      headers: authHeader(),
      timeout: 15000,
    }
  ).catch(() => {}); // non-fatal
}

/**
 * Generate speech from text using a cloned or preset Inworld voice.
 * voiceId can be a cloned ID ("{workspace}__{voice}") or a preset name ("Hades").
 */
export async function textToSpeech(voiceId: string, text: string): Promise<string> {
  const res = await axios.post(
    `${INWORLD_TTS_BASE}/tts/v1/voice`,
    {
      text,
      voiceId,
      modelId: INWORLD_MODEL_ID,
      audioConfig: { audioEncoding: 'MP3' },
    },
    {
      headers: {
        ...authHeader(),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const audioBuffer = Buffer.from(res.data.audioContent, 'base64');
  const filename = `voice_${uuidv4()}.mp3`;

  if (isCloudinaryConfigured) {
    return uploadToCloudinary(audioBuffer, 'chat', 'video', ['tts_audio']);
  }

  const uploadsDir = process.env.UPLOAD_DIR || './uploads';
  const chatDir = path.join(uploadsDir, 'chat');
  if (!fs.existsSync(chatDir)) fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, filename), audioBuffer);
  return `chat/${filename}`;
}

export function isConfigured(): boolean {
  return !!process.env.INWORLD_API_KEY;
}
