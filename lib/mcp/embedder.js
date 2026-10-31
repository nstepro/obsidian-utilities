// Ollama /api/embed client. Batch input, truncate: true, dim probed on first use.

export class Embedder {
    constructor({ ollamaUrl, model, batchSize = 32 }) {
        this.ollamaUrl = ollamaUrl.replace(/\/$/, '');
        this.model = model;
        this.batchSize = batchSize;
        this.dim = null;
    }

    // Returns { dim, embeddings: Float32Array[] } for a batch of texts.
    async embed(texts) {
        if (!texts.length) return { dim: this.dim ?? 0, embeddings: [] };
        const res = await fetch(`${this.ollamaUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, input: texts, truncate: true }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Ollama embed failed ${res.status}: ${body.slice(0, 200)}`);
        }
        const json = await res.json();
        if (!json.embeddings || !Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
            throw new Error(`Ollama embed returned ${json.embeddings?.length ?? 'no'} embeddings for ${texts.length} texts`);
        }
        const embeddings = json.embeddings.map((e) => Float32Array.from(e));
        const dim = embeddings[0].length;
        for (const e of embeddings) {
            if (e.length !== dim) throw new Error('Ollama returned inconsistent embedding dimensions');
        }
        this.dim = dim;
        return { dim, embeddings };
    }

    // L2-normalize in place
    static normalize(v) {
        let sum = 0;
        for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
        const norm = Math.sqrt(sum);
        if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
        return v;
    }
}

// Probe: short embed call to discover dim / verify Ollama is reachable and the model is pulled.
export async function probeEmbedder(embedder) {
    const { dim } = await embedder.embed(['probe']);
    return dim;
}
