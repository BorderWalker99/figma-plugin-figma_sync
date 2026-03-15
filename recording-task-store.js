const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TASK_DIR = path.join(os.homedir(), '.screensync-recording-tasks');
const VALID_STAGES = new Set([
  'queued',
  'downloading',
  'downloaded',
  'converting',
  'gif-ready',
  'import-requested',
  'import-started',
  'import-succeeded',
  'import-failed',
  'failed',
  'done'
]);

function ensureTaskDir() {
  if (!fs.existsSync(TASK_DIR)) {
    fs.mkdirSync(TASK_DIR, { recursive: true });
  }
  return TASK_DIR;
}

function buildTaskPath(taskId) {
  return path.join(ensureTaskDir(), `${taskId}.json`);
}

function now() {
  return new Date().toISOString();
}

function createTaskId(seed = '') {
  return `recording_${Date.now()}_${crypto.createHash('md5').update(`${seed}_${Math.random()}`).digest('hex').slice(0, 10)}`;
}

function sanitizeStage(stage) {
  return VALID_STAGES.has(stage) ? stage : 'queued';
}

function sanitizeTask(task = {}) {
  const base = { ...task };
  if (!base.taskId) {
    base.taskId = createTaskId(base.filename || base.originalFilename || '');
  }
  base.kind = 'recording';
  base.stage = sanitizeStage(base.stage);
  base.createdAt = base.createdAt || now();
  base.updatedAt = now();
  if (!Number.isFinite(base.progress)) delete base.progress;
  if (!Number.isFinite(base.importAttempts)) base.importAttempts = Number(base.importAttempts || 0) || 0;
  return base;
}

function writeTask(task) {
  const next = sanitizeTask(task);
  const targetPath = buildTaskPath(next.taskId);
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));
  fs.renameSync(tempPath, targetPath);
  return next;
}

function readTask(taskId) {
  if (!taskId) return null;
  const targetPath = buildTaskPath(taskId);
  if (!fs.existsSync(targetPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function upsertTask(taskId, patch = {}) {
  const current = taskId ? (readTask(taskId) || { taskId }) : {};
  return writeTask({ ...current, ...patch, taskId: taskId || current.taskId });
}

function createTask(initial = {}) {
  const taskId = initial.taskId || createTaskId(initial.filename || initial.originalFilename || '');
  return upsertTask(taskId, initial);
}

function updateStage(taskId, stage, patch = {}) {
  return upsertTask(taskId, { ...patch, stage: sanitizeStage(stage) });
}

function markImportRequested(taskId, patch = {}) {
  const current = readTask(taskId);
  const attempts = Number((current && current.importAttempts) || 0) + 1;
  return updateStage(taskId, 'import-requested', {
    importAttempts: attempts,
    importRequestedAt: now(),
    lastError: null,
    ...patch
  });
}

function markImportStarted(taskId, patch = {}) {
  return updateStage(taskId, 'import-started', {
    importStartedAt: now(),
    ...patch
  });
}

function markImportSucceeded(taskId, patch = {}) {
  return updateStage(taskId, 'import-succeeded', {
    importSucceededAt: now(),
    lastError: null,
    ...patch
  });
}

function markImportFailed(taskId, error, patch = {}) {
  return updateStage(taskId, 'import-failed', {
    importFailedAt: now(),
    lastError: error || null,
    ...patch
  });
}

function listTasks(options = {}) {
  ensureTaskDir();
  const limit = Math.max(1, Number(options.limit || 50));
  const stages = Array.isArray(options.stages) && options.stages.length > 0
    ? new Set(options.stages.map((item) => String(item)))
    : null;
  const entries = fs.readdirSync(TASK_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readTask(path.basename(name, '.json')))
    .filter(Boolean)
    .filter((task) => !stages || stages.has(task.stage))
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  return entries.slice(0, limit);
}

module.exports = {
  createTaskId,
  createTask,
  readTask,
  upsertTask,
  updateStage,
  markImportRequested,
  markImportStarted,
  markImportSucceeded,
  markImportFailed,
  listTasks
};
