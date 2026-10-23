const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=' }
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const assistant = { role: 'assistant', api: 'openai-completions', provider: 'imported', model: 'imported', usage, stopReason: 'stop', timestamp: 1700000000000 }
module.exports = { image, messages: [
  { role: 'user', content: [{ type: 'text', text: 'Remember ORCHID-731 from this fixture.' }, image], timestamp: 1700000000000 },
  { ...assistant, content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT_SENTINEL', signature: 'PRIVATE_SIGNATURE' }, { type: 'text', text: 'I will read the fixture.' }, { type: 'toolCall', id: 'old|call:1', name: 'read', arguments: { path: 'fixture.txt' } }], stopReason: 'toolUse' },
  { role: 'toolResult', toolCallId: 'old|call:1', toolName: 'read', content: [{ type: 'text', text: 'fixture.txt contains ORCHID-731' }], isError: false, timestamp: 1700000000000 },
  { ...assistant, content: [{ type: 'text', text: 'The project code is ORCHID-731.', textSignature: 'PRIVATE_TEXT_SIGNATURE' }] }
] }
