// 로컬 개발/테스트용 메모리 KV (Cloudflare KV의 get/put/delete/list 중 저녁픽이 쓰는 부분만 흉내낸다)
export class MockKV {
  constructor() { this.m = new Map(); }
  async get(key, type) { const e = this.m.get(key); if (!e) return null; return type === 'json' ? JSON.parse(e.value) : e.value; }
  async put(key, value, opts = {}) { this.m.set(key, { value, metadata: opts.metadata }); }
  async delete(key) { this.m.delete(key); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit)
      .map((name) => ({ name, metadata: this.m.get(name).metadata }));
    return { keys, list_complete: true };
  }
}
