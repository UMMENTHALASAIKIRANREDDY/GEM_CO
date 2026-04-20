import { EventEmitter } from 'events';

// Map<batchId, EventEmitter>
const emitters = new Map();

export function getProgressEmitter(batchId) {
  if (!emitters.has(batchId)) {
    const ee = new EventEmitter();
    ee.setMaxListeners(100);
    emitters.set(batchId, ee);
  }
  return emitters.get(batchId);
}

export function emitProgress(batchId, event) {
  const ee = emitters.get(batchId);
  if (ee) ee.emit('progress', event);
}

export function cleanupEmitter(batchId) {
  emitters.delete(batchId);
}
