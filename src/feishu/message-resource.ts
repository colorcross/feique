import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logging.js';
import type { IncomingMessageContext, MessageAttachment } from '../bridge/types.js';

const SUPPORTED_RESOURCE_TYPES = new Set<MessageAttachment['kind']>(['image', 'file', 'audio', 'media']);
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.sql',
  '.sh',
  '.zsh',
  '.bash',
  '.env',
]);
const DOC_LIKE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.wordml',
  '.webarchive',
]);
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'text/csv',
]);
const MAX_TEXT_EXCERPT_CHARS = 1200;

export async function resolveMessageResources(
  sdkClient: lark.Client | undefined,
  storageDir: string,
  context: IncomingMessageContext,
  options: {
    downloadEnabled: boolean;
    transcribeAudio: boolean;
    transcribeCliPath?: string;
    describeImages?: boolean;
    openaiImageModel?: string;
    logger: Logger;
    transcribe?: (filePath: string, cliPath: string | undefined, logger: Logger) => Promise<string | undefined>;
    describeImage?: (filePath: string, model: string | undefined, attachment: MessageAttachment, logger: Logger) => Promise<string | undefined>;
    extractText?: (filePath: string, attachment: MessageAttachment, logger: Logger) => Promise<string | undefined>;
  },
): Promise<IncomingMessageContext> {
  if (!options.downloadEnabled || context.attachments.length === 0 || !sdkClient?.im?.v1?.messageResource?.get) {
    return context;
  }

  const attachments = await Promise.all(
    context.attachments.map((attachment) => resolveAttachment(sdkClient, storageDir, context, attachment, options)),
  );

  return {
    ...context,
    attachments,
  };
}

async function resolveAttachment(
  sdkClient: lark.Client,
  storageDir: string,
  context: IncomingMessageContext,
  attachment: MessageAttachment,
  options: {
    transcribeAudio: boolean;
    transcribeCliPath?: string;
    describeImages?: boolean;
    openaiImageModel?: string;
    logger: Logger;
    transcribe?: (filePath: string, cliPath: string | undefined, logger: Logger) => Promise<string | undefined>;
    describeImage?: (filePath: string, model: string | undefined, attachment: MessageAttachment, logger: Logger) => Promise<string | undefined>;
    extractText?: (filePath: string, attachment: MessageAttachment, logger: Logger) => Promise<string | undefined>;
  },
): Promise<MessageAttachment> {
  if (!attachment.key || !SUPPORTED_RESOURCE_TYPES.has(attachment.kind)) {
    return attachment;
  }

  try {
    const filePath = await downloadAttachment(sdkClient, storageDir, context.message_id, attachment);
    const transcriptText =
      attachment.kind === 'audio' && options.transcribeAudio
        ? await (options.transcribe ?? transcribeAudioFile)(filePath, options.transcribeCliPath, options.logger)
        : undefined;
    const imageDescription =
      attachment.kind === 'image' && options.describeImages
        ? await (options.describeImage ?? describeImageFile)(filePath, options.openaiImageModel, attachment, options.logger)
        : undefined;
    const contentExcerpt = await (options.extractText ?? extractTextExcerpt)(filePath, attachment, options.logger);

    return {
      ...attachment,
      downloaded_path: filePath,
      transcript_text: transcriptText,
      content_excerpt: contentExcerpt,
      image_description: imageDescription,
    };
  } catch (error) {
    options.logger.warn({ error, messageId: context.message_id, attachment }, 'Failed to download message resource');
    return attachment;
  }
}

async function downloadAttachment(
  sdkClient: lark.Client,
  storageDir: string,
  messageId: string,
  attachment: MessageAttachment,
): Promise<string> {
  const targetDir = path.join(storageDir, 'message-resources', messageId);
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, buildFileName(attachment));
  const resource = await sdkClient.im.v1.messageResource.get({
    params: {
      type: attachment.kind,
    },
    path: {
      message_id: messageId,
      file_key: attachment.key ?? '',
    },
  });
  await resource.writeFile(filePath);
  return filePath;
}

function buildFileName(attachment: MessageAttachment): string {
  if (attachment.name) {
    return sanitizeName(attachment.name);
  }
  const extension = guessExtension(attachment);
  return `${attachment.kind}-${attachment.key ?? Date.now()}${extension}`;
}

function sanitizeName(input: string): string {
  return input.replace(/[^\w.-]+/g, '_');
}

function guessExtension(attachment: MessageAttachment): string {
  if (attachment.name && path.extname(attachment.name)) {
    return '';
  }
  switch (attachment.kind) {
    case 'image':
      return '.png';
    case 'audio':
      return '.mp3';
    case 'media':
      return '.mp4';
    default:
      return '.bin';
  }
}

async function transcribeAudioFile(filePath: string, cliPath: string | undefined, logger: Logger): Promise<string | undefined> {
  if (!process.env.OPENAI_API_KEY) {
    return undefined;
  }

  const resolvedCliPath = resolveTranscribeCliPath(cliPath);
  if (!resolvedCliPath) {
    logger.warn({ filePath }, 'Skipping audio transcription because TRANSCRIBE_CLI is unavailable');
    return undefined;
  }

  const transcriptPath = `${filePath}.transcript.txt`;
  await runCommand('python3', [resolvedCliPath, filePath, '--response-format', 'text', '--out', transcriptPath]);
  const content = await fs.readFile(transcriptPath, 'utf8');
  return content.trim() || undefined;
}

async function describeImageFile(
  filePath: string,
  model: string | undefined,
  attachment: MessageAttachment,
  logger: Logger,
): Promise<string | undefined> {
  if (!process.env.OPENAI_API_KEY) {
    return undefined;
  }

  const imageBytes = await fs.readFile(filePath);
  const mimeType = guessImageMimeType(attachment, filePath);
  const dataUrl = `data:${mimeType};base64,${imageBytes.toString('base64')}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Describe this image for a coding assistant. Extract visible text if present, summarize UI structure or key objects, and keep the answer under 120 Chinese characters.',
            },
            {
              type: 'input_image',
              image_url: dataUrl,
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'text',
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.warn({ status: response.status, body }, 'OpenAI image description request failed');
    return undefined;
  }

  const payload = await response.json() as {
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text?.trim()) {
        return content.text.trim();
      }
    }
  }

  return undefined;
}

function resolveTranscribeCliPath(cliPath?: string): string | undefined {
  const candidates = [
    cliPath,
    process.env.TRANSCRIBE_CLI,
    path.join(os.homedir(), '.codex', 'skills', 'transcribe', 'scripts', 'transcribe_diarize.py'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    return candidate;
  }
  return undefined;
}

async function extractTextExcerpt(filePath: string, attachment: MessageAttachment, logger: Logger): Promise<string | undefined> {
  if (!isTextLikeAttachment(attachment, filePath) && !isDocLikeAttachment(attachment, filePath)) {
    return undefined;
  }

  const content = isDocLikeAttachment(attachment, filePath)
    ? await extractTextViaTextutil(filePath, logger)
    : await fs.readFile(filePath, 'utf8');
  if (!content.trim() || content.includes('\u0000')) {
    return undefined;
  }

  return content.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_EXCERPT_CHARS) || undefined;
}

function isTextLikeAttachment(attachment: MessageAttachment, filePath: string): boolean {
  if (attachment.kind !== 'file') {
    return false;
  }

  const mimeType = attachment.mime_type?.toLowerCase();
  if (mimeType) {
    if (TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || TEXT_MIME_TYPES.has(mimeType)) {
      return true;
    }
  }

  const extension = path.extname(attachment.name ?? filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(extension);
}

function isDocLikeAttachment(attachment: MessageAttachment, filePath: string): boolean {
  if (attachment.kind !== 'file') {
    return false;
  }

  const extension = path.extname(attachment.name ?? filePath).toLowerCase();
  return DOC_LIKE_EXTENSIONS.has(extension);
}

function guessImageMimeType(attachment: MessageAttachment, filePath: string): string {
  const mimeType = attachment.mime_type?.toLowerCase();
  if (mimeType?.startsWith('image/')) {
    return mimeType;
  }

  switch (path.extname(attachment.name ?? filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function runCommandForStdout(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractTextViaTextutil(filePath: string, logger: Logger): Promise<string> {
  try {
    return await runCommandForStdout('textutil', ['-convert', 'txt', '-stdout', filePath]);
  } catch (error) {
    logger.warn({ error, filePath }, 'textutil failed to extract rich document content');
    return '';
  }
}
