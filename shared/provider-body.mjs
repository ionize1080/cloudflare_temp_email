import { Buffer } from 'node:buffer';

// Encode one small chunk at a time. Never buffer a 25 MB attachment or its JSON copy.
export function providerBody(mail, attachments, readAttachment) {
  const encoder = new TextEncoder();
  const prefix = JSON.stringify(mail).slice(0, -1) + ',"attachments":[';
  const headers = attachments.map(a => JSON.stringify({ filename: a.filename }).slice(0, -1) + ',"content":"');
  const length = encoder.encode(prefix).length + 2 + attachments.reduce((sum, a, i) => sum + (i ? 1 : 0) + encoder.encode(headers[i]).length + 4 * Math.ceil(a.size / 3) + 2, 0);
  async function* parts() {
    yield encoder.encode(prefix);
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      const response = await readAttachment(attachment.id);
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Attachment unavailable'); }
      const reader = response.body.getReader();
      let carry = Buffer.alloc(0), count = 0;
      try {
        yield encoder.encode((i ? ',' : '') + headers[i]);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.byteLength;
          if (count > attachment.size) throw new Error('Attachment size mismatch');
          for (let offset = 0; offset < value.byteLength; offset += 49152) {
            const chunk = Buffer.concat([carry, value.subarray(offset, offset + 49152)]);
            const end = chunk.length - chunk.length % 3;
            if (end) yield encoder.encode(chunk.subarray(0, end).toString('base64'));
            carry = Buffer.from(chunk.subarray(end));
          }
        }
        if (count !== attachment.size) throw new Error('Attachment size mismatch');
        if (carry.length) yield encoder.encode(carry.toString('base64'));
        yield encoder.encode('"}');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    yield encoder.encode(']}');
  }
  const iterator = parts();
  const body = new ReadableStream({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(); },
  });
  return { body, length };
}
